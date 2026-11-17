const POSITION_KEY = 'keewebx-connect-launcher-position-v1';
const DRAG_THRESHOLD = 6;
const MARGIN = 8;

type Point = { x: number; y: number };
type Gesture = Point & { pointerId: number; start: Point; dragging: boolean };

/** App-only presentation preference. No Connect credentials or manager storage. */
export class ConnectLauncherDrag {
    private launcher?: HTMLButtonElement;
    private position?: Point;
    private gesture?: Gesture;
    private suppressClick = false;

    constructor(private readonly host: HTMLElement, private readonly moved: () => void) {
        try {
            const value = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
            if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) this.position = { x: value.x, y: value.y };
        } catch { /* Position storage is optional, including on local HTML pages. */ }
        addEventListener('resize', this.reposition);
        addEventListener('orientationchange', this.reposition);
        visualViewport?.addEventListener('resize', this.reposition);
        visualViewport?.addEventListener('scroll', this.reposition);
    }

    ref = (element: HTMLButtonElement | null): void => {
        if (this.launcher === element) return;
        if (this.launcher) {
            this.launcher.removeEventListener('pointerdown', this.pointerDown);
            this.launcher.removeEventListener('pointermove', this.pointerMove);
            this.launcher.removeEventListener('pointerup', this.pointerEnd);
            this.launcher.removeEventListener('pointercancel', this.pointerEnd);
            this.launcher.removeEventListener('lostpointercapture', this.pointerEnd);
            this.launcher.removeEventListener('click', this.click, true);
            this.launcher.removeEventListener('keydown', this.keyDown);
        }
        this.launcher = element ?? undefined;
        this.gesture = undefined;
        element?.addEventListener('pointerdown', this.pointerDown);
        element?.addEventListener('pointermove', this.pointerMove);
        element?.addEventListener('pointerup', this.pointerEnd);
        element?.addEventListener('pointercancel', this.pointerEnd);
        element?.addEventListener('lostpointercapture', this.pointerEnd);
        element?.addEventListener('click', this.click, true);
        element?.addEventListener('keydown', this.keyDown);
    };

    reposition = (): void => {
        if (!this.launcher?.isConnected) return;
        const rect = this.launcher.getBoundingClientRect();
        this.move(this.position ?? { x: rect.left, y: rect.top });
    };

    private move(point: Point): void {
        if (!this.launcher) return;
        const vx = visualViewport?.offsetLeft || 0, vy = visualViewport?.offsetTop || 0;
        const vw = visualViewport?.width || innerWidth, vh = visualViewport?.height || innerHeight;
        const rect = this.launcher.getBoundingClientRect();
        const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
        this.position = {
            x: clamp(point.x, vx + MARGIN, vx + vw - rect.width - MARGIN),
            y: clamp(point.y, vy + MARGIN, vy + vh - rect.height - MARGIN)
        };
        this.host.style.left = `${this.position.x}px`;
        this.host.style.top = `${this.position.y}px`;
        this.host.style.right = 'auto';
        this.host.style.bottom = 'auto';
        this.moved();
    }

    private save(): void {
        try { localStorage.setItem(POSITION_KEY, JSON.stringify(this.position)); }
        catch { /* The launcher remains movable when storage is blocked. */ }
    }

    private pointerDown = (event: PointerEvent): void => {
        if (!event.isTrusted || !event.isPrimary || event.button !== 0 || this.gesture || !this.launcher) return;
        this.suppressClick = false;
        const rect = this.launcher.getBoundingClientRect();
        this.gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
            start: { x: rect.left, y: rect.top }, dragging: false };
        this.launcher.setPointerCapture(event.pointerId);
        event.stopPropagation();
    };

    private pointerMove = (event: PointerEvent): void => {
        const gesture = this.gesture;
        if (!event.isTrusted || !gesture || gesture.pointerId !== event.pointerId) return;
        const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
        if (!gesture.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        gesture.dragging = true;
        this.suppressClick = true;
        this.launcher?.setAttribute('data-dragging', 'true');
        event.preventDefault();
        event.stopPropagation();
        this.move({ x: gesture.start.x + dx, y: gesture.start.y + dy });
    };

    private pointerEnd = (event: PointerEvent): void => {
        const gesture = this.gesture;
        if (!event.isTrusted || !gesture || gesture.pointerId !== event.pointerId) return;
        this.gesture = undefined;
        this.launcher?.removeAttribute('data-dragging');
        if (this.launcher?.hasPointerCapture(event.pointerId)) this.launcher.releasePointerCapture(event.pointerId);
        if (gesture.dragging) {
            this.save();
            event.preventDefault();
            event.stopPropagation();
        }
    };

    private click = (event: MouseEvent): void => {
        // Keyboard and assistive activation must still work immediately after dragging.
        if (!this.suppressClick || event.detail === 0) return;
        this.suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
    };

    private keyDown = (event: KeyboardEvent): void => {
        if (!event.isTrusted || event.altKey || event.ctrlKey || event.metaKey || !this.launcher) return;
        const directions: Record<string, Point> = {
            ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
            ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }
        };
        const direction = directions[event.key];
        if (!direction) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = this.launcher.getBoundingClientRect(), step = event.shiftKey ? 50 : 10;
        this.move({ x: rect.left + direction.x * step, y: rect.top + direction.y * step });
        this.save();
    };
}
