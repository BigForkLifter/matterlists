import React, {useState} from 'react';

import Sheet from './sheet';

import {MANUAL_SORT} from '../sort';
import type {Sort, SortDir} from '../sort';
import {COLUMN_TYPE_LABELS} from '../types';
import type {Column} from '../types';

type Props = {
    sort: Sort;
    columns: Column[];
    onChange: (sort: Sort) => void;
    onClose: () => void;
};

const BUILT_IN = [
    {key: 'title', name: 'Title'},
    {key: 'created', name: 'Date created'},
    {key: 'updated', name: 'Last updated'},
];

// SortSheet picks how this viewer's copy of the list is ordered. Picking a field applies
// it and closes; the direction applies to whichever field is picked.
export default function SortSheet({sort, columns, onChange, onClose}: Props) {
    const [dir, setDir] = useState<SortDir>(sort.dir);
    const pick = (key: string) => {
        onChange(key === 'manual' ? MANUAL_SORT : {key, dir});
        onClose();
    };
    const option = (key: string, name: React.ReactNode, hint?: string) => (
        <button
            key={key}
            className={`ml-option${sort.key === key ? ' ml-option--selected' : ''}`}
            onClick={() => pick(key)}
        >
            <span>
                {name}
                {hint && <span className='ml-muted'>{' · '}{hint}</span>}
            </span>
            {sort.key === key && <span>{'✓'}</span>}
        </button>
    );

    return (
        <Sheet
            title='Sort by'
            onClose={onClose}
        >
            <div
                className='ml-segmented ml-segmented--wide'
                role='radiogroup'
                aria-label='Direction'
            >
                {(['asc', 'desc'] as SortDir[]).map((d) => (
                    <button
                        key={d}
                        role='radio'
                        aria-checked={dir === d}
                        className={dir === d ? 'ml-segmented--on' : ''}
                        onClick={() => {
                            setDir(d);

                            // Flipping the direction re-sorts right away by the current field.
                            if (sort.key !== 'manual') {
                                onChange({key: sort.key, dir: d});
                            }
                        }}
                    >
                        {d === 'asc' ? '↑ Ascending' : '↓ Descending'}
                    </button>
                ))}
            </div>
            <div className='ml-options'>
                {option('manual', 'Manual order', 'use Move up/down on an item')}
                {BUILT_IN.map((b) => option(b.key, b.name))}
                {columns.filter((c) => c.type !== 'photos').map((c) => option(c.id, c.name, COLUMN_TYPE_LABELS[c.type]))}
            </div>
            <div className='ml-muted'>{'Your sort applies only to you. Items without a value go last.'}</div>
        </Sheet>
    );
}
