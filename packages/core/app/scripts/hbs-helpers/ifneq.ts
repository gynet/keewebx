import Handlebars from 'hbs';

interface HbsBlockOptions {
    fn(context: unknown): string;
    inverse(context: unknown): string;
}

Handlebars.registerHelper(
    'ifneq',
    function (this: unknown, lvalue: unknown, rvalue: unknown, options: HbsBlockOptions): string {
        return lvalue !== rvalue ? options.fn(this) : options.inverse(this);
    }
);
