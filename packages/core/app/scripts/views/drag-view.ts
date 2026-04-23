import { View } from 'framework/views/view';
import template from 'templates/drag.hbs';

type DragCoord = 'x' | 'y';

class DragView extends View {
    template = template;

    events: Record<string, string> = {
        'mousedown': 'mousedown'
    };

    coord!: DragCoord;
    offsetProp!: 'pageX' | 'pageY';
    mouseDownTime = -1;
    mouseDownCount = 0;
    initialOffset = 0;
    dragMask: JQuery<HTMLElement> | undefined;

    constructor(coord: DragCoord, options?: Record<string, unknown>) {
        super(coord, options);
        this.setCoord(coord);
        this.mouseDownTime = -1;
        this.mouseDownCount = 0;
    }

    render(): this | undefined {
        super.render({ coord: this.model });
        return this;
    }

    setCoord(coord: DragCoord): void {
        this.coord = coord;
        this.offsetProp = ('page' + coord.toUpperCase()) as 'pageX' | 'pageY';
    }

    mousedown(e: MouseEvent): void {
        if (e.which === 1) {
            const now = Date.now();
            if (now - this.mouseDownTime < 500) {
                this.mouseDownCount++;
                if (this.mouseDownCount === 2) {
                    this.emit('autosize', { coord: this.coord });
                    return;
                }
            } else {
                this.mouseDownTime = now;
                this.mouseDownCount = 1;
            }
            this.initialOffset = e[this.offsetProp];
            const cursor = this.$el.css('cursor');
            this.dragMask = $('<div/>', { 'class': 'drag-mask' })
                .css('cursor', cursor)
                .appendTo('body');
            this.dragMask.on('mousemove', this.mousemove.bind(this));
            this.dragMask.on('mouseup', this.mouseup.bind(this));
            this.emit('dragstart', { offset: this.initialOffset, coord: this.coord });
            this.$el.addClass('dragging');
            e.preventDefault();
        }
    }

    mousemove(e: MouseEvent): void {
        if (e.which === 0) {
            this.mouseup();
        } else {
            this.emit('drag', { offset: e[this.offsetProp] - this.initialOffset });
        }
    }

    mouseup(): void {
        this.dragMask?.remove();
        this.$el.removeClass('dragging');
    }
}

export { DragView };
