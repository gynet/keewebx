import Handlebars from 'hbs';

interface HbsBlockOptions {
    fn(context: unknown): string;
    inverse(context: unknown): string;
}

Handlebars.registerHelper(
    'cmp',
    function (
        this: unknown,
        lvalue: unknown,
        rvalue: unknown,
        op: string,
        options: HbsBlockOptions
    ): string {
        let cond: boolean | undefined;
        switch (op) {
            case '<':
                cond = (lvalue as number) < (rvalue as number);
                break;
            case '>':
                cond = (lvalue as number) > (rvalue as number);
                break;
            case '>=':
                cond = (lvalue as number) >= (rvalue as number);
                break;
            case '<=':
                cond = (lvalue as number) <= (rvalue as number);
                break;
            case '===':
            case '==':
                cond = lvalue === rvalue;
                break;
            case '!==':
            case '!=':
                cond = lvalue !== rvalue;
                break;
        }
        return cond ? options.fn(this) : options.inverse(this);
    }
);
