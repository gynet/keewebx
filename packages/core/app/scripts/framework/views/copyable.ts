import { Events } from 'framework/events';
import { AppSettingsModel } from 'models/app-settings-model';
import { Locale } from 'util/locale';
import { Tip } from 'util/ui/tip';
import { Timeouts } from 'const/timeouts';

const loc = Locale as Record<string, string | undefined>;

// labelEl arrives as a jQuery wrapper from the originating field view.
// We treat it as an opaque element-like array (Tip.createTip indexes
// into it via [0]). The shim from types.d.ts already loose-types
// JQuery, but we narrow further to "indexable element list" here.
interface FieldLabelEl {
    [index: number]: Element;
}

interface CopyEvent {
    source: {
        labelEl: FieldLabelEl;
        model: { name: string };
    };
    copyRes: {
        seconds?: number;
    };
}

interface TipInstance {
    show(): void;
    hide(): void;
}

// Copyable is a mixin attached to view classes via Object.assign.
// The `this` context is a View subclass that has been augmented with
// the mixin's own methods + a `fieldCopyTip` slot, plus the View base
// `isHidden`. We type the receiver structurally rather than via `View`
// directly to avoid a circular import and to keep the mixin's contract
// small.
interface CopyableHost {
    fieldCopyTip: TipInstance | null;
    isHidden(): boolean;
    hideFieldCopyTip(): void;
}

const Copyable = {
    hideFieldCopyTip(this: CopyableHost): void {
        if (this.fieldCopyTip) {
            this.fieldCopyTip.hide();
            this.fieldCopyTip = null;
        }
    },

    fieldCopied(this: CopyableHost, e: CopyEvent): void {
        this.hideFieldCopyTip();
        const fieldLabel = e.source.labelEl;
        const clipboardTime = e.copyRes.seconds;
        const msg: string = clipboardTime
            ? (loc.detFieldCopiedTime ?? '').replace('{}', String(clipboardTime))
            : (loc.detFieldCopied ?? '');
        let tip: TipInstance | undefined;
        if (!this.isHidden()) {
            tip = Tip.createTip(fieldLabel[0], {
                title: msg,
                placement: 'right',
                fast: true,
                force: true,
                noInit: true
            });
            this.fieldCopyTip = tip ?? null;
            // createTip may return undefined when Tip is disabled and
            // the `force: true` override isn't propagated (defensive).
            if (tip) {
                tip.show();
            }
        }
        setTimeout(() => {
            if (tip) {
                tip.hide();
            }
            this.fieldCopyTip = null;
            if (e.source.model.name === '$Password' && AppSettingsModel.lockOnCopy) {
                setTimeout(() => {
                    Events.emit('lock-workspace');
                }, Timeouts.BeforeAutoLock);
            }
        }, Timeouts.CopyTip);
    }
};

export { Copyable };
export type { CopyableHost, CopyEvent };
