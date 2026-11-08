// created_by is filled in automatically with the item's creator.
// photos holds photo IDs; photos are added by uploading them (Client.uploadPhoto).
export type ColumnType = 'text' | 'number' | 'select' | 'multi_select' | 'person' | 'date' | 'checkbox' | 'url' | 'created_by' | 'photos';

export type ChoiceColor = 'gray' | 'blue' | 'green' | 'yellow' | 'orange' | 'red' | 'purple' | 'pink';

export const CHOICE_COLORS: ChoiceColor[] = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink'];

export type Choice = {
    id: string;
    name: string;
    color: ChoiceColor;
};

export type Column = {
    id: string;
    list_id: string;
    name: string;
    type: ColumnType;
    options: {choices?: Choice[]};
    sort_order: number;
    create_at: number;
};

// A cell value as stored: string (text, url, date, select), number, true, or an array of ids.
export type CellValue = string | number | boolean | string[];

export type Item = {
    id: string;
    list_id: string;
    title: string;
    values: Record<string, CellValue>;
    sort_order: number;
    root_post_id: string;
    source_post_id: string;
    creator_id: string;
    create_at: number;
    update_at: number;
};

export type List = {
    id: string;
    channel_id: string;
    title: string;
    description: string;
    creator_id: string;
    create_at: number;
    update_at: number;
    item_count: number;
};

export type ListDetail = {
    list: List;
    columns: Column[];
    items: Item[];
};

// Template is a starting point for new lists: built in, or saved from a list and shared
// with everyone in a team.
export type Template = {
    id: string;
    team_id: string;
    name: string;
    description: string;
    builtin: boolean;
    creator_id: string;
    create_at: number;
    columns: Array<{name: string; type: ColumnType}>;
    item_count: number;
    can_edit: boolean;
};

export const DEFAULT_TEMPLATE_ID = 'tasks';

export type UserLite = {
    id: string;
    username: string;
    first_name?: string;
    last_name?: string;
    nickname?: string;
    last_picture_update?: number;
};

export const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
    text: 'Text',
    number: 'Number',
    select: 'Single select',
    multi_select: 'Multi-select',
    person: 'People',
    date: 'Date',
    checkbox: 'Checkbox',
    url: 'Link',
    created_by: 'Created by',
    photos: 'Photos',
};

// The server's limit on photos per cell (store.MaxPhotosPerCell).
export const MAX_PHOTOS_PER_CELL = 20;
