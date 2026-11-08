import React, {useEffect, useState} from 'react';

import {ChoiceChip} from './fields';
import Sheet from './sheet';
import {SaveTemplateSheet} from './templates';

import {Client} from '../client';
import {columnRequest, deleteList, moveColumn, patchList} from '../data';
import {CHOICE_COLORS, COLUMN_TYPE_LABELS} from '../types';
import type {Choice, Column, ColumnType, ListDetail} from '../types';

// ListSettingsSheet renames or deletes the list and manages its columns.
export default function ListSettingsSheet({detail, onClose}: {detail: ListDetail; onClose: () => void}) {
    const {list} = detail;
    const [savingTemplate, setSavingTemplate] = useState(false);

    const onDelete = () => {
        // eslint-disable-next-line no-alert
        if (window.confirm(`Delete the list “${list.title}” and all its items?`)) {
            deleteList(list);
            onClose();
        }
    };

    return (
        <Sheet
            title='List settings'
            onClose={onClose}
            editor={true}
        >
            <div className='ml-field'>
                <div className='ml-field__label'>{'Name'}</div>
                <BlurInput
                    value={list.title}
                    onCommit={(title) => patchList(list.id, {title})}
                />
            </div>

            <h3 className='ml-section-title'>{'Columns'}</h3>
            <div className='ml-columns'>
                {detail.columns.map((c, i) => (
                    <ColumnEditor
                        key={c.id}
                        column={c}
                        isFirst={i === 0}
                        isLast={i === detail.columns.length - 1}
                        onMove={(direction) => moveColumn(detail, c, direction)}
                    />
                ))}
            </div>
            <AddColumn listId={list.id}/>

            <div className='ml-sheet__footer'>
                <button
                    className='ml-btn ml-btn--ghost'
                    onClick={() => setSavingTemplate(true)}
                >
                    {'Save as template'}
                </button>
                <button
                    className='ml-btn ml-btn--danger'
                    onClick={onDelete}
                >
                    {'Delete list'}
                </button>
            </div>
            {savingTemplate && (
                <SaveTemplateSheet
                    detail={detail}
                    onClose={() => setSavingTemplate(false)}
                />
            )}
        </Sheet>
    );
}

// BlurInput commits a non-empty, changed value when it loses focus or Enter is pressed.
function BlurInput({value, onCommit, placeholder}: {value: string; onCommit: (v: string) => void; placeholder?: string}) {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    const commit = () => {
        const trimmed = draft.trim();
        if (!trimmed) {
            setDraft(value);
        } else if (trimmed !== value) {
            onCommit(trimmed);
        }
    };
    return (
        <input
            className='ml-input'
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
    );
}

type ColumnEditorProps = {
    column: Column;
    isFirst: boolean;
    isLast: boolean;
    onMove: (direction: -1 | 1) => void;
};

function ColumnEditor({column, isFirst, isLast, onMove}: ColumnEditorProps) {
    const [expanded, setExpanded] = useState(false);
    const hasChoices = column.type === 'select' || column.type === 'multi_select';
    const choices = column.options.choices || [];

    const saveChoices = (next: Choice[]) => columnRequest(column.list_id, () => Client.patchColumn(column.id, {options: {choices: next}}));

    const onDelete = () => {
        // eslint-disable-next-line no-alert
        if (window.confirm(`Delete the column “${column.name}”? Its values in every item are removed.`)) {
            columnRequest(column.list_id, () => Client.deleteColumn(column.id));
        }
    };

    return (
        <div className='ml-column-editor'>
            <div className='ml-row'>
                <BlurInput
                    value={column.name}
                    onCommit={(name) => columnRequest(column.list_id, () => Client.patchColumn(column.id, {name}))}
                />
                <button
                    className='ml-icon-btn'
                    aria-label={`Move ${column.name} up`}
                    title='Move up'
                    disabled={isFirst}
                    onClick={() => onMove(-1)}
                >
                    {'↑'}
                </button>
                <button
                    className='ml-icon-btn'
                    aria-label={`Move ${column.name} down`}
                    title='Move down'
                    disabled={isLast}
                    onClick={() => onMove(1)}
                >
                    {'↓'}
                </button>
                <button
                    className='ml-icon-btn'
                    aria-label={`Delete column ${column.name}`}
                    title='Delete column'
                    onClick={onDelete}
                >
                    {'🗑'}
                </button>
            </div>
            <span className='ml-muted ml-column-type'>{COLUMN_TYPE_LABELS[column.type]}</span>
            {hasChoices && (
                <button
                    className='ml-btn ml-btn--ghost'
                    onClick={() => setExpanded(!expanded)}
                    aria-expanded={expanded}
                >
                    {expanded ? 'Hide options' : `Edit options (${choices.length})`}
                </button>
            )}
            {hasChoices && expanded && (
                <div className='ml-choices'>
                    {choices.map((choice, i) => (
                        <div
                            key={choice.id}
                            className='ml-row'
                        >
                            <button
                                className='ml-color-btn'
                                aria-label='Change color'
                                title='Change color'
                                onClick={() => {
                                    const color = CHOICE_COLORS[(CHOICE_COLORS.indexOf(choice.color) + 1) % CHOICE_COLORS.length];
                                    saveChoices(choices.map((c) => (c.id === choice.id ? {...c, color} : c)));
                                }}
                            >
                                <ChoiceChip choice={{...choice, name: ' '}}/>
                            </button>
                            <BlurInput
                                value={choice.name}
                                onCommit={(name) => saveChoices(choices.map((c) => (c.id === choice.id ? {...c, name} : c)))}
                            />
                            <button
                                className='ml-icon-btn'
                                aria-label={`Move ${choice.name} up`}
                                disabled={i === 0}
                                onClick={() => {
                                    const next = [...choices];
                                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
                                    saveChoices(next);
                                }}
                            >
                                {'↑'}
                            </button>
                            <button
                                className='ml-icon-btn'
                                aria-label={`Remove ${choice.name}`}
                                onClick={() => saveChoices(choices.filter((c) => c.id !== choice.id))}
                            >
                                {'✕'}
                            </button>
                        </div>
                    ))}
                    <NewChoice
                        onAdd={(name) => saveChoices([...choices, {id: '', name, color: CHOICE_COLORS[choices.length % CHOICE_COLORS.length]}])}
                    />
                </div>
            )}
        </div>
    );
}

function NewChoice({onAdd}: {onAdd: (name: string) => void}) {
    const [name, setName] = useState('');
    return (
        <form
            className='ml-row'
            onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) {
                    onAdd(name.trim());
                    setName('');
                }
            }}
        >
            <input
                className='ml-input'
                placeholder='New option'
                value={name}
                onChange={(e) => setName(e.target.value)}
            />
            <button
                className='ml-btn ml-btn--ghost'
                type='submit'
                disabled={!name.trim()}
            >
                {'Add'}
            </button>
        </form>
    );
}

function AddColumn({listId}: {listId: string}) {
    const [name, setName] = useState('');
    const [type, setType] = useState<ColumnType>('text');
    return (
        <form
            className='ml-add-column'
            onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim()) {
                    return;
                }
                columnRequest(listId, () => Client.createColumn(listId, {name: name.trim(), type}));
                setName('');
            }}
        >
            <input
                className='ml-input'
                placeholder='New column name'
                value={name}
                onChange={(e) => setName(e.target.value)}
            />
            <div className='ml-row'>
                <select
                    className='ml-input'
                    value={type}
                    aria-label='Column type'
                    onChange={(e) => setType(e.target.value as ColumnType)}
                >
                    {(Object.keys(COLUMN_TYPE_LABELS) as ColumnType[]).map((t) => (
                        <option
                            key={t}
                            value={t}
                        >
                            {COLUMN_TYPE_LABELS[t]}
                        </option>
                    ))}
                </select>
                <button
                    className='ml-btn ml-btn--primary'
                    type='submit'
                    disabled={!name.trim()}
                >
                    {'Add column'}
                </button>
            </div>
        </form>
    );
}
