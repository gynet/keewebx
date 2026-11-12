/* eslint-disable @typescript-eslint/no-explicit-any */
import { Events } from 'framework/events';

interface DragInfo {
    startSize: number;
    prop: string;
    min: number;
    max: number;
    auto?: string | number;
}

interface DragEvent {
    coord: 'x' | 'y';
    offset?: number;
}

const Resizable = {
    listenDrag(this: any, dragView: any): void {
        this.listenTo(dragView, 'dragstart', this.dragStart);
        this.listenTo(dragView, 'drag', this.drag);
        this.listenTo(dragView, 'autosize', this.autoSize);
    },

    dragStart(this: any, e: DragEvent): void {
        this._dragInfo = this.getDragInfo(e.coord);
    },

    drag(this: any, e: DragEvent & { offset: number }): void {
        const dragInfo: DragInfo = this._dragInfo;
        let size: number = dragInfo.startSize + e.offset;
        size = Math.max(dragInfo.min, Math.min(dragInfo.max, size));
        this.$el[dragInfo.prop](size);
        this.emit('view-resize', size);
        Events.emit('page-geometry', { source: 'resizable' });
    },

    autoSize(this: any, e: DragEvent): void {
        const dragInfo: DragInfo = this.getDragInfo(e.coord);
        if (dragInfo.auto !== undefined) {
            this.$el.css(dragInfo.prop, dragInfo.auto);
        } else {
            this.$el.css(dragInfo.prop, '');
        }
        this.fixSize(dragInfo);
        this.emit('view-resize', null);
        Events.emit('page-geometry', { source: 'resizable' });
    },

    fixSize(this: any, cfg: DragInfo): void {
        const size: number = this.$el[cfg.prop]();
        const newSize: number = Math.max(cfg.min, Math.min(cfg.max, size));
        if (newSize !== size) {
            this.$el[cfg.prop](size);
        }
    },

    // TODO: check size on window resize
    // checkSize: function() {
    //     if (this.maxWidth) {
    //         this.fixSize(this.getDragInfo('x'));
    //     }
    //     if (this.maxHeight) {
    //         this.fixSize(this.getDragInfo('y'));
    //     }
    // },

    getDragInfo(this: any, coord: 'x' | 'y'): DragInfo {
        const prop: string = coord === 'x' ? 'Width' : 'Height';
        const propLower: string = prop.toLowerCase();
        const min: number = this.getSizeProp('min' + prop);
        const max: number = this.getSizeProp('max' + prop);
        const auto: string | number | undefined = this.getSizeProp('auto' + prop);
        const startSize: number = this.$el[propLower]();
        return { startSize, prop: propLower, min, max, auto };
    },

    getSizeProp(this: any, prop: string): any {
        const member = this[prop];
        return typeof member === 'function' ? member.call(this) : member;
    }
};

export { Resizable };
