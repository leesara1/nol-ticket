# -*- coding: utf-8 -*-
"""NOL 좌석 화면 수동 접속 + 로컬 화면 관찰 알림기.

브라우저에 접속하거나 새로고침하거나 클릭하지 않습니다.
사용자가 화면에 열어 놓은 좌석 배치도만 컴퓨터 화면에서 관찰합니다.
검출된 색상 변화는 예매 가능 좌석의 확정 증거가 아닙니다.
"""

import argparse
import datetime as dt
import time
import winsound
from pathlib import Path

import cv2
import numpy as np

# 화면을 1초에 한 번 검사합니다. 서버 요청 빈도가 아닙니다.
CHECK_SECONDS = 1.0
# 가상 테스트에서 검증한 작은 좌석 점의 대략적인 픽셀 거리입니다.
MIN_DX, MAX_DX, MAX_DY = 5, 16, 3
RESULT_DIR = Path(__file__).resolve().parent / "screen_alert_results"


def detect_new_colored_points(baseline: np.ndarray, frame: np.ndarray):
    """기준 화면 대비 새롭게 색이 선명해진 작은 영역의 중심 좌표를 찾습니다."""
    if baseline.shape != frame.shape:
        return [], None

    hsv_before = cv2.cvtColor(baseline, cv2.COLOR_BGR2HSV)
    hsv_now = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    sat_before = hsv_before[:, :, 1].astype(np.int16)
    sat_now = hsv_now[:, :, 1].astype(np.int16)
    val_now = hsv_now[:, :, 2]
    max_diff = np.max(cv2.absdiff(baseline, frame), axis=2)

    changed_color = (
        (sat_now >= 55)
        & (val_now >= 65)
        & ((sat_now - sat_before) >= 32)
        & (max_diff >= 35)
    )
    mask = (changed_color.astype(np.uint8) * 255)

    # 붙어 있는 작은 색상 점을 분리합니다.
    cross = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    mask = cv2.erode(mask, cross, iterations=1)

    count, labels, stats, centers = cv2.connectedComponentsWithStats(mask, 8)
    points = []
    for index in range(1, count):
        x, y, width, height, pixels = stats[index]
        if 2 <= width <= 16 and 2 <= height <= 16 and 2 <= pixels <= 120:
            if 0.4 <= width / height <= 2.5:
                cx, cy = centers[index]
                points.append((int(round(cx)), int(round(cy))))
    return points, mask


def find_horizontal_pairs(points):
    """가로로 근접한 점 쌍을 반환합니다. 실제 행·통로 구분은 하지 않습니다."""
    pairs = []
    for i, (x1, y1) in enumerate(points):
        for x2, y2 in points[i + 1:]:
            dx = abs(x2 - x1)
            dy = abs(y2 - y1)
            if MIN_DX <= dx <= MAX_DX and dy <= MAX_DY:
                pairs.append(((x1, y1), (x2, y2)))
    return pairs


def grab_bgr(sct, rect):
    return np.asarray(sct.grab(rect))[:, :, :3].copy()


def save_result(frame, pairs, region):
    RESULT_DIR.mkdir(exist_ok=True)
    marked = frame.copy()
    for left, right in pairs:
        cv2.circle(marked, left, 7, (0, 0, 255), 2)
        cv2.circle(marked, right, 7, (0, 0, 255), 2)
        cv2.line(marked, left, right, (0, 255, 0), 2)
    timestamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    target = RESULT_DIR / f"candidate_{timestamp}.png"
    cv2.imwrite(str(target), marked)
    return target


def run_demo():
    """실제 사이트 접속 없이 0개 / 1개 / 가로 2개 / 세로 2개 검사."""
    before = np.full((120, 180, 3), 235, dtype=np.uint8)
    cases = [
        ("변화 없음", []),
        ("가상 좌석 1개", [(35, 35)]),
        ("가로 2개", [(35, 35), (43, 35)]),
        ("세로 2개", [(35, 35), (35, 43)]),
    ]
    for label, coords in cases:
        current = before.copy()
        for point in coords:
            cv2.circle(current, point, 3, (0, 255, 0), -1)
        points, _ = detect_new_colored_points(before, current)
        pairs = find_horizontal_pairs(points)
        print(f"{label}: 색상 후보 {len(points)}개 / 가로 후보 {len(pairs)}쌍")


def run_watch():
    try:
        from mss import mss
    except ImportError:
        print("필요한 패키지가 없습니다. 먼저 실행: python -m pip install mss")
        return

    with mss() as sct:
        # 단일 모니터 사용을 가정합니다.
        monitor = sct.monitors[1]
        print("5초 안에 NOL 좌석 선택 화면으로 전환하세요 (Alt+Tab).")
        time.sleep(5)
        screenshot = grab_bgr(sct, monitor)
        title = "NOL seat region - drag then ENTER (ESC to cancel)"
        cv2.namedWindow(title, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(title, min(1250, screenshot.shape[1]),
                         min(800, screenshot.shape[0]))
        print("NOL 좌석이 보이는 상태에서 좌석 배치도 영역만 드래그하세요.")
        print("드래그 후 ENTER로 확정합니다. 취소는 ESC입니다.")
        x, y, w, h = map(int, cv2.selectROI(title, screenshot, False, False))
        cv2.destroyAllWindows()
        if w == 0 or h == 0:
            print("영역 선택이 취소되었습니다.")
            return

        region = {
            "left": monitor["left"] + x,
            "top": monitor["top"] + y,
            "width": w,
            "height": h,
        }
        print("선택 창을 닫았습니다. 화면에 NOL 좌석도가 계속 보이도록 유지하세요.")
        print("5초 후 기준 화면을 저장합니다. NOL 창을 앞으로 두고 마우스는 좌석도 밖으로 옮기세요.")
        time.sleep(5)
        baseline = grab_bgr(sct, region)
        print("화면 자동 관찰 시작: 새로고침이나 클릭 없이 화면만 검사합니다.")
        print("후보 발견 시 알림음 + 결과 이미지 저장 / 종료: CMD에서 Ctrl+C")
        print("참고: 실제 예매 가능 여부, 행, 통로는 확인하지 못합니다.")

        consecutive = 0
        armed = True
        warned_movement = False

        while True:
            now = grab_bgr(sct, region)
            changed_fraction = np.mean(np.max(cv2.absdiff(baseline, now), axis=2) > 45)
            if changed_fraction > 0.18:
                if not warned_movement:
                    print("화면이 크게 달라졌습니다. 창 이동이나 팝업이 있는지 확인하세요.")
                    warned_movement = True
                consecutive = 0
                time.sleep(CHECK_SECONDS)
                continue
            warned_movement = False

            points, _ = detect_new_colored_points(baseline, now)
            pairs = find_horizontal_pairs(points)

            if pairs:
                consecutive += 1
                if consecutive >= 2 and armed:
                    armed = False
                    output = save_result(now, pairs, region)
                    clock = dt.datetime.now().strftime("%H:%M:%S")
                    print(f"[{clock}] 가로 인접 색상 후보 {len(pairs)}쌍! 직접 확인하세요.")
                    print(f"결과 이미지: {output}")
                    winsound.Beep(1200, 350)
                    winsound.Beep(1500, 350)
                    winsound.Beep(1800, 350)
            else:
                consecutive = 0
                armed = True

            time.sleep(CHECK_SECONDS)


def main():
    parser = argparse.ArgumentParser(description="NOL 좌석 화면 로컬 관찰 알림")
    parser.add_argument("--demo", action="store_true", help="가상 좌석 테스트만 실행")
    args = parser.parse_args()
    if args.demo:
        run_demo()
    else:
        try:
            run_watch()
        except KeyboardInterrupt:
            print("\n감시를 종료했습니다.")


if __name__ == "__main__":
    main()
