/* eslint-disable @typescript-eslint/no-explicit-any */
import { Locale } from 'util/locale';
import { StringFormat } from 'util/formatting/string-format';
import { DateFormat } from 'comp/i18n/date-format';
import { AppModel } from 'models/app-model';
import { FieldViewReadOnly } from 'views/fields/field-view-read-only';
import { FieldViewOtp } from 'views/fields/field-view-otp';
import { FieldViewSelect } from 'views/fields/field-view-select';
import { FieldViewAutocomplete } from 'views/fields/field-view-autocomplete';
import { FieldViewText } from 'views/fields/field-view-text';
import { FieldViewUrl } from 'views/fields/field-view-url';
import { FieldViewTags } from 'views/fields/field-view-tags';
import { FieldViewDate } from 'views/fields/field-view-date';
import { FieldViewHistory } from 'views/fields/field-view-history';
import { FieldViewCustom } from 'views/fields/field-view-custom';
import { ExtraUrlFieldName } from 'models/entry-model';

const loc = Locale as unknown as Record<string, any>;
const appModel = AppModel as unknown as { instance: any };

interface DetailsFieldsResult {
    fieldViews: any[];
    fieldViewsAside: any[];
}

function createDetailsFields(detailsView: any): DetailsFieldsResult {
    const model = detailsView.model;

    const fieldViews: any[] = [];
    const fieldViewsAside: any[] = [];

    {
        const writeableFiles = appModel.instance.files.filter(
            (file: any) => file.active && !file.readOnly
        );
        if (model.isJustCreated && writeableFiles.length > 1) {
            const fileNames = writeableFiles.map((file: any) => {
                return { id: file.id, value: file.name, selected: file === model.file };
            });
            fieldViews.push(
                new FieldViewSelect({
                    name: '$File',
                    title: StringFormat.capFirst(loc.file as string),
                    value() {
                        return fileNames;
                    }
                })
            );
        } else {
            if (model.backend) {
                fieldViewsAside.push(
                    new FieldViewReadOnly({
                        name: 'Storage',
                        title: StringFormat.capFirst(loc.storage as string),
                        value() {
                            return model.fileName;
                        }
                    })
                );
            } else {
                fieldViewsAside.push(
                    new FieldViewReadOnly({
                        name: 'File',
                        title: StringFormat.capFirst(loc.file as string),
                        value() {
                            return model.fileName;
                        }
                    })
                );
            }
        }
        fieldViews.push(
            new FieldViewAutocomplete({
                name: '$UserName',
                title: StringFormat.capFirst(loc.user as string),
                value() {
                    return model.user;
                },
                getCompletions: detailsView.getUserNameCompletions.bind(detailsView),
                sequence: '{USERNAME}'
            })
        );
        fieldViews.push(
            new FieldViewText({
                name: '$Password',
                title: StringFormat.capFirst(loc.password as string),
                canGen: true,
                value() {
                    return model.password;
                },
                sequence: '{PASSWORD}'
            })
        );
        fieldViews.push(
            new FieldViewUrl({
                name: '$URL',
                title: StringFormat.capFirst(loc.website as string),
                value() {
                    return model.url;
                },
                sequence: '{URL}'
            })
        );
        fieldViews.push(
            new FieldViewText({
                name: '$Notes',
                title: StringFormat.capFirst(loc.notes as string),
                multiline: 'true',
                markdown: true,
                value() {
                    return model.notes;
                },
                sequence: '{NOTES}'
            })
        );
        if (model.file.supportsTags) {
            fieldViews.push(
                new FieldViewTags({
                    name: 'Tags',
                    title: StringFormat.capFirst(loc.tags as string),
                    tags: appModel.instance.tags,
                    value() {
                        return model.tags;
                    }
                })
            );
        }
        if (model.file.supportsExpiration) {
            fieldViews.push(
                new FieldViewDate({
                    name: 'Expires',
                    title: loc.detExpires as string,
                    lessThanNow: '(' + (loc.detExpired as string) + ')',
                    value() {
                        return model.expires;
                    }
                })
            );
        }
        fieldViewsAside.push(
            new FieldViewReadOnly({
                name: 'Group',
                title: loc.detGroup as string,
                value() {
                    return model.groupName;
                },
                tip() {
                    return model.getGroupPath().join(' / ');
                }
            })
        );
        if (model.created) {
            fieldViewsAside.push(
                new FieldViewReadOnly({
                    name: 'Created',
                    title: loc.detCreated as string,
                    value() {
                        return DateFormat.dtStr(model.created);
                    }
                })
            );
        }
        if (model.updated) {
            fieldViewsAside.push(
                new FieldViewReadOnly({
                    name: 'Updated',
                    title: loc.detUpdated as string,
                    value() {
                        return DateFormat.dtStr(model.updated);
                    }
                })
            );
        }
        fieldViewsAside.push(
            new FieldViewHistory({
                name: 'History',
                title: StringFormat.capFirst(loc.history as string),
                value() {
                    return { length: model.historyLength, unsaved: model.unsaved };
                }
            })
        );
        for (const field of Object.keys(model.fields)) {
            if (field === 'otp' && model.otpGenerator) {
                fieldViews.push(
                    new FieldViewOtp({
                        name: '$' + field,
                        title: loc.detOtpField as string,
                        value() {
                            return model.otpGenerator;
                        },
                        sequence: '{TOTP}'
                    })
                );
            } else {
                const isUrl = field.startsWith(ExtraUrlFieldName);
                if (isUrl) {
                    fieldViews.push(
                        new FieldViewUrl({
                            name: '$' + field,
                            title: StringFormat.capFirst(loc.website as string),
                            isExtraUrl: true,
                            value() {
                                return model.fields[field];
                            },
                            sequence: `{S:${field}}`
                        })
                    );
                } else {
                    fieldViews.push(
                        new FieldViewCustom({
                            name: '$' + field,
                            title: field,
                            multiline: true,
                            value() {
                                return model.fields[field];
                            },
                            sequence: `{S:${field}}`
                        })
                    );
                }
            }
        }
    }

    return { fieldViews, fieldViewsAside };
}

function createNewCustomField(
    newFieldTitle: string,
    newFieldOptions: any,
    model: any
): FieldViewUrl | FieldViewCustom {
    const isUrl = newFieldTitle.startsWith(ExtraUrlFieldName);

    if (isUrl) {
        return new FieldViewUrl(
            {
                name: '$' + newFieldTitle,
                title: StringFormat.capFirst(loc.website as string),
                newField: newFieldTitle,
                isExtraUrl: true,
                value: () => model.fields[newFieldTitle]
            },
            newFieldOptions
        );
    } else {
        return new FieldViewCustom(
            {
                name: '$' + newFieldTitle,
                title: newFieldTitle,
                newField: newFieldTitle,
                multiline: true,
                value: () => ''
            },
            newFieldOptions
        );
    }
}

export { createDetailsFields, createNewCustomField };
