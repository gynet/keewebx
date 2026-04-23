/* eslint-disable @typescript-eslint/no-explicit-any */
import baron from 'baron';
import { Events } from 'framework/events';
import { Features } from 'util/features';

const isEnabled: boolean = !Features.isMobile;

const SymbolRemoveScrollListenerAdded: unique symbol = Symbol('removeScrollAdded');

const Scrollable = {
    createScroll(this: any, opts: any): void {
        // opts.cssGuru = true;
        if (isEnabled) {
            if (this.scroll) {
                this.removeScroll();
            }
            this.scroll = baron(opts);
            if (!this[SymbolRemoveScrollListenerAdded]) {
                this.once('remove', () => this.removeScroll);
                this[SymbolRemoveScrollListenerAdded] = true;
            }
        }
        this.scroller = this.$el.find('.scroller');
        this.scrollerBar = this.$el.find('.scroller__bar');
        this.scrollerBarWrapper = this.$el.find('.scroller__bar-wrapper');
    },

    removeScroll(this: any): void {
        if (this.scroll) {
            try {
                this.scroll.dispose();
            } catch {
                // ignore dispose errors
            }
            this.scroll = null;
        }
    },

    pageResized(this: any): void {
        // TODO: check size on window resize
        // if (this.checkSize && (!e || e.source === 'window')) {
        //     this.checkSize();
        // }
        if (this.scroll) {
            this.scroll.update();
            requestAnimationFrame(() => {
                if (this.scroll) {
                    this.scroll.update();
                    const barHeight: number = Math.round(this.scrollerBar.height());
                    const wrapperHeight: number = Math.round(this.scrollerBarWrapper.height());
                    this.scrollerBarWrapper.toggleClass('invisible', barHeight >= wrapperHeight);
                }
            });
        }
    },

    initScroll(this: any): void {
        if (isEnabled) {
            this.listenTo(Events, 'page-geometry', this.pageResized);
        }
    }
};

export { Scrollable };
