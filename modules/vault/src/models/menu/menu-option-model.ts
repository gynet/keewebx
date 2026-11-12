import { Model } from 'framework/model';

interface MenuOptionProperties {
    title: string;
    cls: string;
    value: string;
    active: boolean;
    filterValue: string | null;
}

class MenuOptionModel extends Model {
    declare title: string;
    declare cls: string;
    declare value: string;
    declare active: boolean;
    declare filterValue: string | null;
}

MenuOptionModel.defineModelProperties({
    title: '',
    cls: '',
    value: '',
    active: false,
    filterValue: null
});

export { MenuOptionModel };
export type { MenuOptionProperties };
