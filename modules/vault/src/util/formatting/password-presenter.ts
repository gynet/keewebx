import 'util/kdbxweb/protected-value-ex';
import { shuffle } from 'util/fn';

interface ProtectedValue {
    forEachChar(fn: (charCode: number) => void | false): void;
}

class RandomNameGenerator {
    randomCharCode(): number {
        return 97 + Math.floor(Math.random() * 26);
    }
}

function charCodeToHtml(char: number): string {
    // convert certain special chars like space into to non-breaking space
    // ' ' to &#nbsp;
    if (char === 32 || char === 8193 || char === 8239) {
        char = 160;
    }
    return Math.random() < 0.2 ? String.fromCharCode(char) : `&#x${char.toString(16)};`;
}

interface DomItem {
    html: string;
    order: number;
}

const PasswordPresenter = {
    present(length: number): string {
        return new Array(length + 1).join('\u2022');
    },

    presentValueWithLineBreaks(value: ProtectedValue | null | undefined): string {
        if (!value) {
            return '';
        }
        let result = '';
        value.forEachChar((ch: number) => {
            result += ch === 10 ? '\n' : '\u2022';
        });
        return result;
    },

    asDOM(value: ProtectedValue): HTMLDivElement {
        const items: DomItem[] = [];

        const gen = new RandomNameGenerator();

        let ix = 0;
        value.forEachChar((char: number) => {
            const charHtml = charCodeToHtml(char);
            items.push({ html: charHtml, order: ix });

            if (Math.random() > 0.5) {
                const fakeChar = gen.randomCharCode();
                const fakeCharHtml = charCodeToHtml(fakeChar);
                items.push({ html: fakeCharHtml, order: -1 });
            }
            ix++;
        });

        shuffle(items);

        const topEl = document.createElement('div');
        topEl.style.display = 'flex';
        topEl.style.overflow = 'hidden';
        topEl.style.textOverflow = 'ellipsis';

        for (const item of items) {
            const el = document.createElement('div');
            el.innerHTML = item.html;
            if (item.order >= 0) {
                el.style.order = String(item.order);
            } else {
                el.style.display = 'none';
            }
            topEl.appendChild(el);
        }

        return topEl;
    }
};

export { PasswordPresenter };
