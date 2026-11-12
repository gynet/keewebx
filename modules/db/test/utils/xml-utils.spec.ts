import { describe, test, expect } from 'bun:test';
import {
    ByteUtils,
    ChaCha20,
    Consts,
    KdbxError,
    KdbxUuid,
    ProtectedValue,
    ProtectSaltGenerator,
    XmlUtils
} from '../../lib';

describe('XmlUtils', () => {
    function removeSpaces(str: string) {
        return str.replace(/\s/g, '');
    }

    const isNode = !!global.process?.versions?.node;

    describe('parse', () => {
        test('parses XML document', () => {
            const xml = XmlUtils.parse('<root><item><cd>&lt;&gt;</cd></item></root>');
            expect(xml.documentElement.nodeName).toBe('root');
            expect(xml.documentElement.firstChild!.nodeName).toBe('item');
            expect(xml.documentElement.firstChild!.firstChild!.nodeName).toBe('cd');
            expect(xml.documentElement.firstChild!.firstChild!.textContent).toBe('<>');
        });

        if (isNode) {
            test('uses the global DOMParser if possible', () => {
                const doc = {
                    documentElement: 'hello',
                    getElementsByTagName: () => []
                };
                try {
                    // @ts-ignore
                    global.DOMParser = class {
                        parseFromString() {
                            return doc;
                        }
                    };
                    const xml = XmlUtils.parse('<root><item><cd>&lt;&gt;</cd></item></root>');
                    expect(xml).toBe(doc);
                } finally {
                    // @ts-ignore
                    delete global.DOMParser;
                }
            });
        }

        test('throws error for non-xml document', () => {
            expect(() => {
                XmlUtils.parse('err');
            }).toThrow();
        });

        test('throws error for malformed xml document', () => {
            expect(() => {
                XmlUtils.parse('<root><item><cd>&lt;&gt;</cd></item></bad>');
            }).toThrow();
        });

        test('throws error for generated parseerror element', () => {
            expect(() => {
                XmlUtils.parse('<root><parsererror/></root>');
            }).toThrow();
        });

        test('parses bad characters', () => {
            let chars = '';
            for (let i = 0; i <= 0x20; i++) {
                chars += String.fromCharCode(i);
            }
            for (let j = 0x80; j <= 0xff; j++) {
                chars += String.fromCharCode(j);
            }
            const xml = XmlUtils.parse('<root><item><cd>' + chars + '</cd></item></root>');
            expect(xml.documentElement.nodeName).toBe('root');
            expect(xml.documentElement.firstChild!.nodeName).toBe('item');
        });
    });

    describe('serialize', () => {
        test('serializes XML document', () => {
            const doc = XmlUtils.parse('<root><item><cd>123</cd><e></e></item></root>');
            const xml = XmlUtils.serialize(doc);
            expect(xml).toBe('<root><item><cd>123</cd><e/></item></root>');
        });

        test('pretty prints XML document', () => {
            const doc = XmlUtils.parse('<root><item><cd>123</cd><e></e></item></root>');
            const xml = XmlUtils.serialize(doc, true);
            expect(xml).toBe(
                '<root>\n    <item>\n        <cd>123</cd>\n        <e/>\n    </item>\n</root>'
            );
        });

        if (isNode) {
            test('uses the global XMLSerializer if possible', () => {
                try {
                    // @ts-ignore
                    global.XMLSerializer = class {
                        serializeToString() {
                            return 'xml';
                        }
                    };
                    const doc = XmlUtils.parse('<root><item><cd>123</cd><e></e></item></root>');
                    const xml = XmlUtils.serialize(doc, true);
                    expect(xml).toBe('xml');
                } finally {
                    // @ts-ignore
                    delete global.XMLSerializer;
                }
            });
        }

        test('pretty prints processing instructions', () => {
            const doc = XmlUtils.parse(
                '<?xml version="1.0" encoding="UTF-8"?><root><item><cd>123</cd><e></e></item></root>'
            );
            const xml = XmlUtils.serialize(doc, true);
            expect(xml).toBe(
                '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n    <item>\n        <cd>123</cd>\n        <e/>\n    </item>\n</root>'
            );
        });
    });

    describe('create', () => {
        test('creates XML document', () => {
            const doc = XmlUtils.create('root');
            expect(doc.documentElement.nodeName).toBe('root');
        });
    });

    describe('getChildNode', () => {
        test('gets first child node', () => {
            const xml = XmlUtils.parse('<root><item>1</item><item>2</item></root>');
            const childNode = XmlUtils.getChildNode(xml.documentElement, 'item');
            expect(childNode).toBeTruthy();
            expect(childNode!.textContent).toBe('1');
        });

        test("gets null if there's no matching child node", () => {
            const xml = XmlUtils.parse('<root><item>1</item><item>2</item></root>');
            const childNode = XmlUtils.getChildNode(xml.documentElement, 'notexisting');
            expect(childNode).toBe(null);
        });

        test('gets null for null', () => {
            const childNode = XmlUtils.getChildNode(null, 'notexisting');
            expect(childNode).toBe(null);
        });

        test("gets null if there's no child nodes at all", () => {
            const xml = XmlUtils.parse('<root><item/></root>');
            let childNode = XmlUtils.getChildNode(xml.documentElement, 'item');
            expect(childNode).toBeTruthy();
            childNode = XmlUtils.getChildNode(childNode, 'notexisting');
            expect(childNode).toBe(null);
        });

        test("throws error if there's no matching node", () => {
            const xml = XmlUtils.parse('<root><item/></root>');
            expect(() => {
                XmlUtils.getChildNode(xml.documentElement, 'notexisting', 'not found');
            }).toThrow();
        });
    });

    describe('addChildNode', () => {
        test('adds child node and returns it', () => {
            const xml = XmlUtils.parse('<root><old/></root>');
            const childNode = XmlUtils.addChildNode(xml.documentElement, 'item');
            XmlUtils.addChildNode(childNode, 'inner');
            expect(removeSpaces(XmlUtils.serialize(xml))).toBe(
                '<root><old/><item><inner/></item></root>'
            );
        });
    });

    describe('getText', () => {
        test('returns node text', () => {
            const xml = XmlUtils.parse('<item> some text </item>');
            const text = XmlUtils.getText(xml.documentElement);
            expect(text).toBe(' some text ');
        });

        test('returns empty string for existing node without content', () => {
            const xml = XmlUtils.parse('<item></item>');
            const text = XmlUtils.getText(xml.documentElement);
            expect(text).toBe('');
        });

        test('returns empty string for empty node', () => {
            const xml = XmlUtils.parse('<item/>');
            const text = XmlUtils.getText(xml.documentElement);
            expect(text).toBe('');
        });

        test('returns undefined for not existing node node', () => {
            const text = XmlUtils.getText(null);
            expect(text).toBe(undefined);
        });

        test('returns node protected value if any', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            xml.documentElement.protectedValue = ProtectedValue.fromString('pr');
            const text = XmlUtils.getText(xml.documentElement);
            expect(text).toBe('pr');
        });
    });

    describe('setText', () => {
        test('sets node text', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setText(xml.documentElement, 'new');
            expect(XmlUtils.serialize(xml)).toBe('<item>new</item>');
        });

        test('sets node empty text', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setText(xml.documentElement, undefined);
            expect(removeSpaces(XmlUtils.serialize(xml))).toBe('<item/>');
        });

        test('escapes special characters', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setText(xml.documentElement, ']]>');
            expect(XmlUtils.serialize(xml)).toBe('<item>]]&gt;</item>');
        });
    });

    describe('getTags', () => {
        test('returns node tags', () => {
            const xml = XmlUtils.parse('<item>Tag1 ; Tag2, Another tag  , more tags </item>');
            const tags = XmlUtils.getTags(xml.documentElement);
            expect(tags).toEqual(['Tag1', 'Tag2', 'Another tag', 'more tags']);
        });

        test('returns empty tags for an empty node', () => {
            const xml = XmlUtils.parse('<item></item>');
            const tags = XmlUtils.getTags(xml.documentElement);
            expect(tags).toEqual([]);
        });

        test('returns empty tags for a closed node', () => {
            const xml = XmlUtils.parse('<item />');
            const tags = XmlUtils.getTags(xml.documentElement);
            expect(tags).toEqual([]);
        });

        test('returns empty tags for a node with blank text', () => {
            const xml = XmlUtils.parse('<item>   </item>');
            const tags = XmlUtils.getTags(xml.documentElement);
            expect(tags).toEqual([]);
        });
    });

    describe('setTags', () => {
        test('sets node tags', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setTags(xml.documentElement, ['Tag1', 'Tag2', 'Another tag', 'more tags']);
            expect(XmlUtils.serialize(xml)).toBe(
                '<item>Tag1, Tag2, Another tag, more tags</item>'
            );
        });

        test('sets node empty tags', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setTags(xml.documentElement, []);
            expect(removeSpaces(XmlUtils.serialize(xml))).toBe('<item/>');
        });
    });

    describe('getBytes', () => {
        test('returns node bytes', () => {
            const xml = XmlUtils.parse('<item>YWJj</item>');
            const bytes = new Uint8Array(XmlUtils.getBytes(xml.documentElement)!);
            expect(bytes).toEqual(
                new Uint8Array(['a'.charCodeAt(0), 'b'.charCodeAt(0), 'c'.charCodeAt(0)])
            );
        });

        test('returns undefined for empty node', () => {
            const xml = XmlUtils.parse('<item></item>');
            const bytes = XmlUtils.getBytes(xml.documentElement);
            expect(bytes).toBe(undefined);
        });
    });

    describe('setBytes', () => {
        test('sets node bytes from array', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setBytes(xml.documentElement, new Uint8Array([1, 2, 3]));
            expect(XmlUtils.serialize(xml)).toBe('<item>AQID</item>');
        });

        test('sets node bytes from base64 string', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setBytes(xml.documentElement, 'AQID');
            expect(XmlUtils.serialize(xml)).toBe('<item>AQID</item>');
        });

        test('sets node empty bytes', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setBytes(xml.documentElement, undefined);
            expect(removeSpaces(XmlUtils.serialize(xml))).toBe('<item/>');
            XmlUtils.setBytes(xml.documentElement, '');
            expect(removeSpaces(XmlUtils.serialize(xml))).toBe('<item/>');
            XmlUtils.setBytes(xml.documentElement, new Uint8Array(0));
            expect(removeSpaces(XmlUtils.serialize(xml))).toBe('<item/>');
        });
    });

    describe('setDate', () => {
        test('sets node date in ISO format', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setDate(xml.documentElement, new Date('2015-08-17T21:20Z'));
            expect(XmlUtils.serialize(xml)).toBe('<item>2015-08-17T21:20:00Z</item>');
        });

        test('sets node date in binary format', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setDate(xml.documentElement, new Date('2015-08-16T14:45:23.000Z'), true);
            expect(XmlUtils.serialize(xml)).toBe('<item>A5lizQ4AAAA=</item>');
        });

        test('sets node empty date', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setDate(xml.documentElement, undefined);
            expect(removeSpaces(XmlUtils.serialize(xml))).toBe('<item/>');
        });
    });

    describe('getDate', () => {
        test('returns node date', () => {
            const xml = XmlUtils.parse('<item>2015-01-02T03:04:05Z</item>');
            const dt = XmlUtils.getDate(xml.documentElement);
            expect(dt!.getUTCFullYear()).toBe(2015);
            expect(dt!.getUTCMonth()).toBe(0);
            expect(dt!.getUTCDate()).toBe(2);
            expect(dt!.getUTCHours()).toBe(3);
            expect(dt!.getUTCMinutes()).toBe(4);
            expect(dt!.getUTCSeconds()).toBe(5);
        });

        test('returns node date from base64', () => {
            const xml = XmlUtils.parse('<item>A5lizQ4AAAA=</item>');
            const dt = XmlUtils.getDate(xml.documentElement);
            expect(dt!.toISOString()).toBe('2015-08-16T14:45:23.000Z');
        });

        test('returns undefined for empty node', () => {
            const xml = XmlUtils.parse('<item></item>');
            const dt = XmlUtils.getDate(xml.documentElement);
            expect(dt).toBe(undefined);
        });
    });

    describe('getNumber', () => {
        test('returns node number', () => {
            const xml = XmlUtils.parse('<item>123</item>');
            const num = XmlUtils.getNumber(xml.documentElement);
            expect(num).toBe(123);
        });

        test('returns undefined for empty node', () => {
            const xml = XmlUtils.parse('<item></item>');
            const num = XmlUtils.getNumber(xml.documentElement);
            expect(num).toBe(undefined);
        });
    });

    describe('setNumber', () => {
        test('sets node number', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setNumber(xml.documentElement, 1);
            expect(XmlUtils.serialize(xml)).toBe('<item>1</item>');
        });

        test('sets zero as node number', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setNumber(xml.documentElement, 0);
            expect(XmlUtils.serialize(xml)).toBe('<item>0</item>');
        });

        test('sets node empty number', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setNumber(xml.documentElement, undefined);
            expect(removeSpaces(XmlUtils.serialize(xml))).toBe('<item/>');
            XmlUtils.setNumber(xml.documentElement, NaN);
            expect(removeSpaces(XmlUtils.serialize(xml))).toBe('<item/>');
        });
    });

    describe('getBoolean', () => {
        test('returns node true', () => {
            let xml = XmlUtils.parse('<item>True</item>');
            let bool = XmlUtils.getBoolean(xml.documentElement);
            expect(bool).toBe(true);
            xml = XmlUtils.parse('<item>true</item>');
            bool = XmlUtils.getBoolean(xml.documentElement);
            expect(bool).toBe(true);
        });

        test('returns node false', () => {
            let xml = XmlUtils.parse('<item>False</item>');
            let bool = XmlUtils.getBoolean(xml.documentElement);
            expect(bool).toBe(false);
            xml = XmlUtils.parse('<item>false</item>');
            bool = XmlUtils.getBoolean(xml.documentElement);
            expect(bool).toBe(false);
        });

        test('returns undefined for unknown text', () => {
            const xml = XmlUtils.parse('<item>blablabla</item>');
            const bool = XmlUtils.getBoolean(xml.documentElement);
            expect(bool).toBe(undefined);
        });

        test('returns null for null', () => {
            const xml = XmlUtils.parse('<item>null</item>');
            const bool = XmlUtils.getBoolean(xml.documentElement);
            expect(bool).toBe(null);
        });

        test('returns undefined for empty node', () => {
            const xml = XmlUtils.parse('<item></item>');
            const bool = XmlUtils.getBoolean(xml.documentElement);
            expect(bool).toBe(undefined);
        });

        test('returns undefined for closed node', () => {
            const xml = XmlUtils.parse('<item />');
            const bool = XmlUtils.getBoolean(xml.documentElement);
            expect(bool).toBe(undefined);
        });
    });

    describe('strToBoolean', () => {
        test('converts "true" to boolean', () => {
            expect(XmlUtils.strToBoolean('true')).toBe(true);
        });

        test('converts "false" to boolean', () => {
            expect(XmlUtils.strToBoolean('false')).toBe(false);
        });

        test('converts "null" to boolean', () => {
            expect(XmlUtils.strToBoolean('null')).toBe(null);
        });

        test('converts a bad string to null', () => {
            expect(XmlUtils.strToBoolean('bad')).toBe(undefined);
        });

        test('converts an empty string to undefined', () => {
            expect(XmlUtils.strToBoolean('')).toBe(undefined);
        });

        test('converts null to undefined', () => {
            expect(XmlUtils.strToBoolean(null)).toBe(undefined);
        });

        test('converts undefined to undefined', () => {
            expect(XmlUtils.strToBoolean(undefined)).toBe(undefined);
        });
    });

    describe('setBoolean', () => {
        test('sets node false', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setBoolean(xml.documentElement, false);
            expect(removeSpaces(XmlUtils.serialize(xml))).toBe('<item>False</item>');
        });

        test('sets node true', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setBoolean(xml.documentElement, true);
            expect(XmlUtils.serialize(xml)).toBe('<item>True</item>');
        });

        test('sets node null', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setBoolean(xml.documentElement, null);
            expect(XmlUtils.serialize(xml)).toBe('<item>null</item>');
        });

        test('sets node empty boolean', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setBoolean(xml.documentElement, undefined);
            expect(removeSpaces(XmlUtils.serialize(xml))).toBe('<item/>');
        });
    });

    describe('getUuid', () => {
        test('returns node uuid', () => {
            const xml = XmlUtils.parse('<item>hADuI/JGbkmnRZxNNIZDew==</item>');
            const uuid = XmlUtils.getUuid(xml.documentElement);
            expect(uuid).toBeTruthy();
            expect(uuid?.id).toBe('hADuI/JGbkmnRZxNNIZDew==');
        });

        test('returns undefined for empty node', () => {
            const xml = XmlUtils.parse('<item></item>');
            const uuid = XmlUtils.getUuid(xml.documentElement);
            expect(uuid).toBe(undefined);
        });
    });

    describe('setUuid', () => {
        test('sets node uuid', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setUuid(xml.documentElement, new KdbxUuid(new ArrayBuffer(16)));
            expect(XmlUtils.serialize(xml)).toBe('<item>AAAAAAAAAAAAAAAAAAAAAA==</item>');
        });

        test('sets node empty uuid', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setUuid(xml.documentElement, undefined);
            expect(removeSpaces(XmlUtils.serialize(xml))).toBe('<item/>');
        });
    });

    describe('getProtectedText', () => {
        test('returns node protected text', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            const pv = ProtectedValue.fromString('pv');
            xml.documentElement.protectedValue = pv;
            const res = XmlUtils.getProtectedText(xml.documentElement);
            expect(res).toBe(pv);
        });

        test('returns node text as protected text', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            const res = XmlUtils.getProtectedText(xml.documentElement);
            expect(res).toBe('text');
        });

        test('returns empty string as protected text for node without text', () => {
            const xml = XmlUtils.parse('<item></item>');
            const res = XmlUtils.getProtectedText(xml.documentElement);
            expect(res).toBe('');
        });

        test('returns empty string as protected text for empty node', () => {
            const xml = XmlUtils.parse('<item></item>');
            const res = XmlUtils.getProtectedText(xml.documentElement);
            expect(res).toBe('');
        });
    });

    describe('setProtectedText', () => {
        test('sets node protected text as protected value', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            const pv = ProtectedValue.fromString('str');
            XmlUtils.setProtectedText(xml.documentElement, pv);
            expect(XmlUtils.serialize(xml)).toBe('<item Protected="True">text</item>');
            expect(xml.documentElement.protectedValue).toBe(pv);
        });

        test('sets node protected text as text', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setProtectedText(xml.documentElement, 'str');
            expect(XmlUtils.serialize(xml)).toBe('<item>str</item>');
            expect(xml.documentElement.protectedValue).toBe(undefined);
        });
    });

    describe('getProtectedBinary', () => {
        test('returns node protected binary', () => {
            const xml = XmlUtils.parse('<item>YWJj</item>');
            const pv = ProtectedValue.fromString('pv');
            xml.documentElement.protectedValue = pv;
            const res = XmlUtils.getProtectedBinary(xml.documentElement);
            expect(res).toBe(pv);
        });

        test('returns node ref as protected binary', () => {
            const xml = XmlUtils.parse('<item Ref="MyRef">YWJj</item>');
            const res = XmlUtils.getProtectedBinary(xml.documentElement);
            expect(res).toEqual({ ref: 'MyRef' });
        });

        test('returns undefined as protected binary', () => {
            const xml = XmlUtils.parse('<item></item>');
            const res = XmlUtils.getProtectedBinary(xml.documentElement);
            expect(res).toBe(undefined);
        });

        test('returns node text as protected binary', () => {
            const xml = XmlUtils.parse('<item>YWJj</item>');
            const res = XmlUtils.getProtectedBinary(xml.documentElement);
            expect(ByteUtils.bytesToString(res as ArrayBuffer)).toBe('abc');
        });

        test('decompresses node text as protected binary', () => {
            const xml = XmlUtils.parse(
                '<item Compressed="True">H4sIAAAAAAAAA0tMSgYAwkEkNQMAAAA=</item>'
            );
            const res = XmlUtils.getProtectedBinary(xml.documentElement);
            expect(ByteUtils.bytesToString(res as ArrayBuffer)).toBe('abc');
        });
    });

    describe('setProtectedBinary', () => {
        test('sets node protected binary as protected value', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            const pv = ProtectedValue.fromString('str');
            XmlUtils.setProtectedBinary(xml.documentElement, pv);
            expect(XmlUtils.serialize(xml)).toBe('<item Protected="True">text</item>');
            expect(xml.documentElement.protectedValue).toBe(pv);
        });

        test('sets node protected binary as ref', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setProtectedBinary(xml.documentElement, { ref: '123' });
            expect(XmlUtils.serialize(xml)).toBe('<item Ref="123">text</item>');
            expect(xml.documentElement.protectedValue).toBe(undefined);
        });

        test('sets node protected binary as text', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setProtectedBinary(xml.documentElement, ByteUtils.base64ToBytes('YWJj'));
            expect(XmlUtils.serialize(xml)).toBe('<item>YWJj</item>');
            expect(xml.documentElement.protectedValue).toBe(undefined);
        });

        test('sets node protected binary as encoded text', () => {
            const xml = XmlUtils.parse('<item>text</item>');
            XmlUtils.setProtectedBinary(xml.documentElement, new TextEncoder().encode('abc'));
            expect(XmlUtils.serialize(xml)).toBe('<item>YWJj</item>');
            expect(xml.documentElement.protectedValue).toBe(undefined);
        });
    });

    describe('setProtectedValues', () => {
        test('sets protected values', () => {
            const xml = XmlUtils.parse(
                '<root><item1><inner Protected="True">MTIz</inner><i2 Protected="True"></i2></item1>' +
                    '<item2 Protected="True">NDU2</item2></root>'
            );
            let count = 0;

            class TestPSG extends ProtectSaltGenerator {
                constructor() {
                    super(new ChaCha20(new Uint8Array(32), new Uint8Array(32)));
                }

                getSalt(): ArrayBuffer {
                    count++;
                    return new Uint8Array([count, count, count]);
                }
            }

            XmlUtils.setProtectedValues(xml.documentElement, new TestPSG());
            const item1 = XmlUtils.getChildNode(xml.documentElement, 'item1');
            const item2 = XmlUtils.getChildNode(xml.documentElement, 'item2');
            const inner = XmlUtils.getChildNode(item1, 'inner');
            expect(item1!.protectedValue).toBe(undefined);
            expect(item2!.protectedValue).toBeTruthy();
            expect(inner!.protectedValue).toBeTruthy();
            expect(inner!.protectedValue!.getText()).toBe('032');
            expect(item2!.protectedValue!.getText()).toBe('674');
        });

        test('generates error for bad protected values', () => {
            const xml = XmlUtils.parse('<root><inner Protected="True">MTIz</inner></root>');

            class TestPSGThrows extends ProtectSaltGenerator {
                constructor() {
                    super(new ChaCha20(new Uint8Array(32), new Uint8Array(32)));
                }

                getSalt(): ArrayBuffer {
                    throw new Error('boom');
                }
            }

            expect(() => {
                XmlUtils.setProtectedValues(xml.documentElement, new TestPSGThrows());
            }).toThrow();
        });
    });

    describe('updateProtectedValuesSalt', () => {
        test('sets protected values', () => {
            const xml = XmlUtils.parse(
                '<root><item1><inner Protected="True">MTIz</inner><i2 Protected="True"></i2></item1>' +
                    '<item2 Protected="True">NDU2</item2></root>'
            );
            const item1 = XmlUtils.getChildNode(xml.documentElement, 'item1');
            const item2 = XmlUtils.getChildNode(xml.documentElement, 'item2');
            const inner = XmlUtils.getChildNode(item1, 'inner');
            inner!.protectedValue = ProtectedValue.fromString('123');
            item2!.protectedValue = ProtectedValue.fromString('456');
            let count = 0;

            class TestPSG extends ProtectSaltGenerator {
                constructor() {
                    super(new ChaCha20(new Uint8Array(32), new Uint8Array(32)));
                }

                getSalt(): ArrayBuffer {
                    count++;
                    return new Uint8Array([count, count, count]);
                }
            }

            XmlUtils.updateProtectedValuesSalt(xml.documentElement, new TestPSG());
            expect(new Uint8Array(inner!.protectedValue.salt)).toEqual(
                new Uint8Array([1, 1, 1])
            );
            expect(new Uint8Array(item2!.protectedValue.salt)).toEqual(
                new Uint8Array([2, 2, 2])
            );
        });
    });

    describe('unprotectValues', () => {
        test('unprotects protected values', () => {
            const xml = XmlUtils.parse(
                '<root><item1><inner Protected="True">MTIz</inner><i2 Protected="True"></i2></item1>' +
                    '<item2 Protected="True">NDU2</item2></root>'
            );
            const item1 = XmlUtils.getChildNode(xml.documentElement, 'item1');
            const item2 = XmlUtils.getChildNode(xml.documentElement, 'item2');
            const inner = XmlUtils.getChildNode(item1, 'inner');
            inner!.protectedValue = ProtectedValue.fromString('123');
            item2!.protectedValue = ProtectedValue.fromString('456');
            XmlUtils.unprotectValues(xml.documentElement);
            expect(XmlUtils.serialize(inner as Document)).toBe(
                '<inner ProtectInMemory="True">123</inner>'
            );
            expect(XmlUtils.serialize(item2 as Document)).toBe(
                '<item2 ProtectInMemory="True">456</item2>'
            );
        });
    });

    describe('protectUnprotectedValues', () => {
        test('protects unprotected values', () => {
            const xml = XmlUtils.parse(
                '<root><item1><inner ProtectInMemory="True">123</inner><i2 ProtectInMemory="True"></i2></item1>' +
                    '<item2 ProtectInMemory="True">NDU2</item2></root>'
            );
            const item1 = XmlUtils.getChildNode(xml.documentElement, 'item1');
            const item2 = XmlUtils.getChildNode(xml.documentElement, 'item2');
            const inner = XmlUtils.getChildNode(item1, 'inner');
            const salt = new ArrayBuffer(16);
            inner!.protectedValue = ProtectedValue.fromString('123');
            item2!.protectedValue = ProtectedValue.fromString('456');
            inner!.protectedValue.setSalt(salt);
            item2!.protectedValue.setSalt(salt);
            XmlUtils.protectUnprotectedValues(xml.documentElement);
            expect(XmlUtils.serialize(inner as Document)).toBe(
                '<inner Protected="True">MTIz</inner>'
            );
            expect(XmlUtils.serialize(item2 as Document)).toBe(
                '<item2 Protected="True">NDU2</item2>'
            );
        });
    });

    describe('protectPlainValues', () => {
        test('protects plain values', () => {
            const xml = XmlUtils.parse(
                '<root><item1><inner ProtectInMemory="True">123</inner><i2 ProtectInMemory="True"></i2></item1>' +
                    '<item2 ProtectInMemory="True">456</item2></root>'
            );
            XmlUtils.protectPlainValues(xml.documentElement);
            const item1 = XmlUtils.getChildNode(xml.documentElement, 'item1');
            const item2 = XmlUtils.getChildNode(xml.documentElement, 'item2');
            const inner = XmlUtils.getChildNode(item1, 'inner');

            expect(item1!.protectedValue).toBe(undefined);
            expect(item2!.protectedValue).toBeTruthy();
            expect(inner!.protectedValue).toBeTruthy();
            expect(inner!.protectedValue!.getText()).toBe('123');
            expect(item2!.protectedValue!.getText()).toBe('456');
            expect(inner!.textContent).toBe(inner!.protectedValue!.toString());
            expect(item2!.textContent).toBe(item2!.protectedValue!.toString());
            expect((inner as Element).getAttribute('Protected')).toBeTruthy();
            expect((inner as Element).getAttribute('ProtectInMemory')).toBeFalsy();
        });
    });
});
