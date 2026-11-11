interface JQueryLike {
    addClass(className: string): JQueryLike;
    removeClass(className: string): JQueryLike;
}

const InputFx = {
    shake(el: JQueryLike): void {
        el.addClass('input-shake');
        setTimeout(() => el.removeClass('input-shake'), 1000);
    }
};

export { InputFx };
