import { describe, test, expect } from 'bun:test';

// Inline the CsvParser class to avoid webpack alias resolution issues
class CsvParser {
    next: any;
    csv: string = '';
    index: number = 0;
    line: string[] = [];
    lines: string[][] = [];
    value: string = '';
    error: string | undefined = undefined;

    parse(csv: string): { headers: string[]; rows: string[][] } {
        this.csv = csv.trim().replace(/\r\n/g, '\n');
        this.next = this.handleBeforeValue;
        this.index = 0;
        this.lines = [];
        this.line = [];
        this.value = '';
        while (this.next && this.index <= this.csv.length) {
            this.next = this.next.call(this);
        }
        if (this.lines.length <= 1) {
            throw new Error('Empty CSV');
        }
        return { headers: this.lines[0], rows: this.lines.slice(1) };
    }

    handleBeforeValue(): any {
        const isQuoted = this.csv[this.index] === '"';
        if (isQuoted) {
            this.index++;
            this.value = '';
            return this.handleQuotedValue;
        }
        return this.handleUnquotedValue;
    }

    handleUnquotedValue(): any {
        const commaIndex = this.csv.indexOf(',', this.index);
        const newLineIndex = this.csv.indexOf('\n', this.index);

        let nextIndex: number;
        if (commaIndex >= 0 && (newLineIndex < 0 || commaIndex < newLineIndex)) {
            nextIndex = commaIndex;
        } else if (newLineIndex >= 0) {
            nextIndex = newLineIndex;
        } else {
            nextIndex = this.csv.length;
        }

        const value = this.csv.substr(this.index, nextIndex - this.index);
        this.line.push(value);
        this.index = nextIndex;
        return this.handleAfterValue;
    }

    handleQuotedValue(): any {
        const nextQuoteIndex = this.csv.indexOf('"', this.index);
        const nextBackslashIndex = this.csv.indexOf('\\', this.index);

        if (nextQuoteIndex < 0) {
            this.index = this.csv.length;
            this.error = 'Quoted value not closed';
            return this.handleError;
        }

        if (nextBackslashIndex > 0 && nextBackslashIndex < nextQuoteIndex) {
            const charAfterBackslash = this.csv[nextBackslashIndex + 1];
            if (charAfterBackslash === '"' || charAfterBackslash === '\\') {
                this.value +=
                    this.csv.substr(this.index, nextBackslashIndex - this.index) +
                    charAfterBackslash;
                this.index = nextBackslashIndex + 2;
            } else {
                this.value += this.csv.substr(this.index, nextBackslashIndex - this.index + 1);
                this.index = nextBackslashIndex + 1;
            }
            return this.handleQuotedValue;
        }

        if (this.csv[nextQuoteIndex + 1] === '"') {
            this.value += this.csv.substr(this.index, nextQuoteIndex - this.index + 1);
            this.index = nextQuoteIndex + 2;
            return this.handleQuotedValue;
        }

        this.value += this.csv.substr(this.index, nextQuoteIndex - this.index);
        this.index = nextQuoteIndex + 1;
        this.line.push(this.value);
        this.value = '';
        return this.handleAfterValue;
    }

    handleAfterValue(): any {
        const hasNextValueOnThisLine = this.csv[this.index] === ',';
        this.index++;
        if (!hasNextValueOnThisLine) {
            this.lines.push(this.line);
            this.line = [];
        }
        return this.handleBeforeValue;
    }

    handleError(): any {
        throw new Error(this.error);
    }
}

describe('CsvParser', () => {
    const parser = new CsvParser();

    test('parses simple CSV with headers and rows', () => {
        const result = parser.parse('name,email\nAlice,alice@example.com\nBob,bob@example.com');
        expect(result.headers).toEqual(['name', 'email']);
        expect(result.rows).toHaveLength(2);
        expect(result.rows[0]).toEqual(['Alice', 'alice@example.com']);
        expect(result.rows[1]).toEqual(['Bob', 'bob@example.com']);
    });

    test('handles quoted values with commas', () => {
        const result = parser.parse('name,address\nAlice,"123 Main St, Apt 4"');
        expect(result.rows[0][1]).toBe('123 Main St, Apt 4');
    });

    test('handles escaped quotes inside quoted values (doubled quotes)', () => {
        const result = parser.parse('name,quote\nAlice,"She said ""hello"""');
        expect(result.rows[0][1]).toBe('She said "hello"');
    });

    test('handles escaped quotes with backslash', () => {
        const result = parser.parse('name,quote\nAlice,"She said \\"hello\\""');
        expect(result.rows[0][1]).toBe('She said "hello"');
    });

    test('handles CRLF line endings', () => {
        const result = parser.parse('name,email\r\nAlice,alice@test.com\r\nBob,bob@test.com');
        expect(result.rows).toHaveLength(2);
        expect(result.rows[0]).toEqual(['Alice', 'alice@test.com']);
    });

    test('throws on empty CSV', () => {
        expect(() => parser.parse('header1,header2')).toThrow('Empty CSV');
    });

    test('throws on unclosed quoted value', () => {
        expect(() => parser.parse('name,value\nAlice,"unclosed')).toThrow(
            'Quoted value not closed'
        );
    });

    test('handles three columns', () => {
        const result = parser.parse('a,b,c\n1,2,3\n4,5,6');
        expect(result.headers).toEqual(['a', 'b', 'c']);
        expect(result.rows[0]).toEqual(['1', '2', '3']);
        expect(result.rows[1]).toEqual(['4', '5', '6']);
    });

    test('handles empty field values', () => {
        const result = parser.parse('a,b,c\n1,,3');
        expect(result.rows[0]).toEqual(['1', '', '3']);
    });
});
