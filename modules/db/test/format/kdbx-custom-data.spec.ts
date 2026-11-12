import { describe, test, expect } from 'bun:test';
import { Kdbx, KdbxContext, KdbxCustomData, KdbxCustomDataItem, XmlUtils } from '../../lib';

describe('KdbxCustomData', () => {
    const kdbx = new Kdbx();
    const ctx = new KdbxContext({ kdbx });

    test('reads custom data from xml', () => {
        const xml = XmlUtils.parse(
            '<CustomData>' +
                '<Item><Key>k1</Key><Value>v1</Value></Item>' +
                '<Item><Key>k2</Key><Value>v2</Value></Item>' +
                '</CustomData>'
        );
        const cd = KdbxCustomData.read(xml.documentElement);
        expect([...cd.entries()]).toEqual([
            ['k1', { value: 'v1' }],
            ['k2', { value: 'v2' }]
        ]);
    });

    test('reads empty custom data from empty xml', () => {
        const xml = XmlUtils.parse('<CustomData></CustomData>');
        const cd = KdbxCustomData.read(xml.documentElement);
        expect(cd.size).toBe(0);
    });

    test('skips unknown tags', () => {
        const xml = XmlUtils.parse(
            '<CustomData><Item><Key>k</Key><Value>v</Value><x></x></Item><Something></Something></CustomData>'
        );
        const cd = KdbxCustomData.read(xml.documentElement);
        expect([...cd.entries()]).toEqual([['k', { value: 'v' }]]);
    });

    test('skips empty keys', () => {
        const xml = XmlUtils.parse(
            '<CustomData><Item><Key></Key><Value>v</Value></Item></CustomData>'
        );
        const cd = KdbxCustomData.read(xml.documentElement);
        expect(cd.size).toBe(0);
    });

    test('writes custom data to xml', () => {
        const xml = XmlUtils.create('root');
        KdbxCustomData.write(
            xml.documentElement,
            ctx,
            new Map([
                ['k1', { value: 'v1' }],
                ['k2', { value: 'v2' }]
            ])
        );
        expect(XmlUtils.serialize(<Document>(<unknown>xml.documentElement))).toEqual(
            '<root><CustomData>' +
                '<Item><Key>k1</Key><Value>v1</Value></Item>' +
                '<Item><Key>k2</Key><Value>v2</Value></Item>' +
                '</CustomData></root>'
        );
    });

    test('writes empty custom data to xml', () => {
        const xml = XmlUtils.create('root');
        KdbxCustomData.write(xml.documentElement, ctx, new Map());
        expect(
            XmlUtils.serialize(<Document>(<unknown>xml.documentElement)).replace(/\s/g, '')
        ).toEqual('<root><CustomData/></root>');
    });

    test('does not create tag for empty custom data', () => {
        const xml = XmlUtils.create('root');
        KdbxCustomData.write(xml.documentElement, ctx, undefined);
        expect(
            XmlUtils.serialize(<Document>(<unknown>xml.documentElement)).replace(/\s/g, '')
        ).toEqual('<root/>');
    });

    test('skips keys without values', () => {
        const xml = XmlUtils.create('root');
        KdbxCustomData.write(
            xml.documentElement,
            ctx,
            new Map<string, KdbxCustomDataItem>([
                ['k1', { value: 'v1' }],
                ['k2', { value: '' }],
                ['k3', { value: undefined }]
            ])
        );
        expect(XmlUtils.serialize(<Document>(<unknown>xml.documentElement))).toEqual(
            '<root><CustomData>' +
                '<Item><Key>k1</Key><Value>v1</Value></Item>' +
                '</CustomData></root>'
        );
    });
});
