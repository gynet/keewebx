import { Events } from 'framework/events';
import { Features } from 'util/features';
import { pick } from 'util/fn';

type TipPlacement = 'top' | 'top-left' | 'bottom' | 'left' | 'right';

interface TipConfig {
    title?: string;
    placement?: TipPlacement;
    fast?: boolean;
    force?: boolean;
    noInit?: boolean;
}

interface TipElement extends Element {
    _tip?: Tip;
}

// jQuery wrapper alias — uses the legacy JQuery<T> shim from types.d.ts
// (which is intentionally loose for the documented "no @types/jquery"
// reason). This local alias forwards to that centralised shim instead
// of redeclaring its own loose type.
type JQ = JQuery;

class Tip {
    static enabled: boolean = !Features.isMobile;

    el: JQ;
    title: string;
    placement: TipPlacement | string | null;
    fast: boolean;
    tipEl: JQ | null;
    showTimeout: ReturnType<typeof setTimeout> | null;
    hideTimeout: ReturnType<typeof setTimeout> | null;
    force: boolean;

    constructor(el: JQ, config?: TipConfig) {
        this.el = el;
        this.title = (config && config.title) || el.attr('title');
        this.placement = (config && config.placement) || el.attr('tip-placement');
        this.fast = (config && config.fast) || false;
        this.tipEl = null;
        this.showTimeout = null;
        this.hideTimeout = null;
        this.force = (config && config.force) || false;
        this.hide = this.hide.bind(this);
        this.destroy = this.destroy.bind(this);
        this.mouseenter = this.mouseenter.bind(this);
        this.mouseleave = this.mouseleave.bind(this);
    }

    init(): void {
        if (!Tip.enabled) {
            return;
        }
        this.el.removeAttr('title');
        this.el.attr('data-title', this.title);
        this.el.mouseenter(this.mouseenter).mouseleave(this.mouseleave);
        this.el.click(this.mouseleave);
    }

    show(): void {
        if ((!Tip.enabled && !this.force) || !this.title) {
            return;
        }
        Events.on('page-geometry', this.hide);
        if (this.tipEl) {
            this.tipEl.remove();
            if (this.hideTimeout) {
                clearTimeout(this.hideTimeout);
                this.hideTimeout = null;
            }
        }
        const tipEl = (this.tipEl = ($('<div></div>') as JQ)
            .addClass('tip')
            .appendTo('body')
            .text(this.title));
        const rect: DOMRect = this.el[0].getBoundingClientRect();
        const tipRect: DOMRect = this.tipEl[0].getBoundingClientRect();
        const placement = this.placement || this.getAutoPlacement(rect, tipRect);
        tipEl.addClass('tip--' + placement);
        if (this.fast) {
            tipEl.addClass('tip--fast');
        }
        let top: number | undefined;
        let left: number | undefined;
        const offset = 10;
        const sideOffset = 10;
        switch (placement) {
            case 'top':
                top = rect.top - tipRect.height - offset;
                left = rect.left + rect.width / 2 - tipRect.width / 2;
                break;
            case 'top-left':
                top = rect.top - tipRect.height - offset;
                left = rect.left + rect.width / 2 - tipRect.width + sideOffset;
                break;
            case 'bottom':
                top = rect.bottom + offset;
                left = rect.left + rect.width / 2 - tipRect.width / 2;
                break;
            case 'left':
                top = rect.top + rect.height / 2 - tipRect.height / 2;
                left = rect.left - tipRect.width - offset;
                break;
            case 'right':
                top = rect.top + rect.height / 2 - tipRect.height / 2;
                left = rect.right + offset;
                break;
        }
        tipEl.css({ top, left });
    }

    hide(): void {
        if (this.tipEl) {
            this.tipEl.remove();
            this.tipEl = null;
            Events.off('page-geometry', this.hide);
        }
    }

    destroy(): void {
        this.hide();

        this.el.off('mouseenter', this.mouseenter);
        this.el.off('mouseleave', this.mouseleave);
        this.el.off('click', this.mouseleave);

        if (this.showTimeout) {
            clearTimeout(this.showTimeout);
            this.showTimeout = null;
        }
        if (this.hideTimeout) {
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
        }
    }

    mouseenter(): void {
        if (this.showTimeout) {
            return;
        }
        this.showTimeout = setTimeout(() => {
            this.showTimeout = null;
            this.show();
        }, 200);
    }

    mouseleave(): void {
        if (this.tipEl) {
            this.tipEl.addClass('tip--hide');
            this.hideTimeout = setTimeout(() => {
                this.hideTimeout = null;
                this.hide();
            }, 500);
        }
        if (this.showTimeout) {
            clearTimeout(this.showTimeout);
            this.showTimeout = null;
        }
    }

    getAutoPlacement(rect: DOMRect, tipRect: DOMRect): TipPlacement {
        const padding = 20;
        const bodyRect = document.body.getBoundingClientRect();
        const canShowToBottom = bodyRect.bottom - rect.bottom > padding + tipRect.height;
        const canShowToHalfRight = bodyRect.right - rect.right > padding + tipRect.width / 2;
        const canShowToRight = bodyRect.right - rect.right > padding + tipRect.width;
        const canShowToHalfLeft = rect.left > padding + tipRect.width / 2;
        const canShowToLeft = rect.left > padding + tipRect.width;
        if (canShowToBottom) {
            if (canShowToLeft && !canShowToHalfRight) {
                return 'left';
            } else if (canShowToRight && !canShowToHalfLeft) {
                return 'right';
            } else {
                return 'bottom';
            }
        }
        if (canShowToLeft && !canShowToHalfRight) {
            return 'left';
        } else if (canShowToRight && !canShowToHalfLeft) {
            return 'right';
        } else {
            return 'top';
        }
    }

    static createTips(container: Element): void {
        if (!Tip.enabled) {
            return;
        }
        ($('[title]', container) as JQ).each((_ix: number, el: TipElement) => {
            Tip.createTip(el);
        });
    }

    static createTip(el: TipElement, options?: TipConfig): Tip | undefined {
        if (!Tip.enabled && (!options || !options.force)) {
            return;
        }
        const tip = new Tip($(el), options);
        if (!options || !options.noInit) {
            tip.init();
        }
        el._tip = tip;
        return tip;
    }

    static hideTips(container: Element | null): void {
        if (!Tip.enabled || !container) {
            return;
        }
        ($('[data-title]', container) as JQ).each((_ix: number, el: TipElement) => {
            Tip.hideTip(el);
        });
    }

    static hideTip(el: TipElement): void {
        if (el._tip) {
            el._tip.hide();
        }
    }

    static updateTip(el: TipElement, props: Record<string, unknown>): void {
        if (el._tip) {
            el._tip.hide();
            Object.assign(
                el._tip,
                pick(props, ['title', 'placement', 'fast', 'showTimeout', 'hideTimeout'])
            );
        }
    }

    static destroyTips(container: Element): void {
        ($('[data-title]', container) as JQ).each((_ix: number, el: TipElement) => {
            if (el._tip) {
                el._tip.destroy();
                el._tip = undefined;
            }
        });
    }
}

export { Tip };
