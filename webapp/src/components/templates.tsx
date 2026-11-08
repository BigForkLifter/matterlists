import React, {useEffect, useState} from 'react';

import Sheet from './sheet';

import {currentTeamId, deleteTemplate, patchTemplate, saveTemplate, useTemplates} from '../data';
import type {ListDetail, Template} from '../types';
import {columnsLine} from '../utils';

type PickerProps = {
    value: string;
    onChange: (templateId: string) => void;
};

// TemplatePicker chooses what a new list starts with: the built-in templates, then
// the ones people in the team saved. Saved ones can be edited by whoever saved them.
export function TemplatePicker({value, onChange}: PickerProps) {
    const templates = useTemplates(currentTeamId());
    const [editing, setEditing] = useState<Template | null>(null);

    // If the chosen template is deleted, fall back to the default.
    useEffect(() => {
        if (templates && !templates.some((t) => t.id === value)) {
            onChange(templates[0]?.id || '');
        }
    }, [templates, value, onChange]);

    if (!templates) {
        return <div className='ml-muted'>{'Loading templates…'}</div>;
    }
    const builtin = templates.filter((t) => t.builtin);
    const saved = templates.filter((t) => !t.builtin);

    const option = (t: Template) => (
        <div
            key={t.id}
            className={`ml-template${t.id === value ? ' ml-template--selected' : ''}`}
        >
            <button
                type='button'
                className='ml-template__pick'
                aria-pressed={t.id === value}
                onClick={() => onChange(t.id)}
            >
                <span className='ml-template__name'>
                    {t.name}
                    {t.id === value && <span className='ml-template__check'>{'✓'}</span>}
                </span>
                {t.description && <span className='ml-template__desc'>{t.description}</span>}
                <span className='ml-template__cols'>{columnsLine(t)}</span>
            </button>
            {t.can_edit && (
                <button
                    type='button'
                    className='ml-btn ml-btn--ghost ml-template__edit'
                    aria-label={`Edit template ${t.name}`}
                    onClick={() => setEditing(t)}
                >
                    {'Edit'}
                </button>
            )}
        </div>
    );

    return (
        <div
            className='ml-templates'
            role='group'
            aria-label='Template'
        >
            <div className='ml-field__label'>{'Start from'}</div>
            {builtin.map(option)}
            {saved.length > 0 && <div className='ml-field__label ml-templates__saved'>{'Saved in this team'}</div>}
            {saved.map(option)}
            {editing && (
                <TemplateEditSheet
                    template={editing}
                    onClose={() => setEditing(null)}
                />
            )}
        </div>
    );
}

// TemplateEditSheet renames, re-describes or deletes a saved template. Changes save as
// they're made, like the other editor sheets.
function TemplateEditSheet({template, onClose}: {template: Template; onClose: () => void}) {
    const [name, setName] = useState(template.name);
    const [description, setDescription] = useState(template.description);
    const [current, setCurrent] = useState(template);

    const commit = async (patch: {name?: string; description?: string}) => {
        const updated = await patchTemplate(current, patch);
        if (updated) {
            setCurrent(updated);
        } else {
            setName(current.name);
            setDescription(current.description);
        }
    };

    const onDelete = () => {
        // eslint-disable-next-line no-alert
        if (window.confirm(`Delete the template “${current.name}”? Lists already made from it aren't affected.`)) {
            deleteTemplate(current);
            onClose();
        }
    };

    return (
        <Sheet
            title='Edit template'
            onClose={onClose}
            editor={true}
        >
            <div className='ml-field'>
                <div className='ml-field__label'>{'Name'}</div>
                <input
                    className='ml-input'
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => {
                        const trimmed = name.trim();
                        if (!trimmed) {
                            setName(current.name);
                        } else if (trimmed !== current.name) {
                            commit({name: trimmed});
                        }
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
            </div>
            <div className='ml-field'>
                <div className='ml-field__label'>{'Description'}</div>
                <input
                    className='ml-input'
                    value={description}
                    placeholder='What this template is for'
                    maxLength={200}
                    onChange={(e) => setDescription(e.target.value)}
                    onBlur={() => description.trim() !== current.description && commit({description: description.trim()})}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
            </div>
            <div className='ml-muted'>{columnsLine(current)}</div>
            <div className='ml-muted'>{'To change its columns or items, make a list from it, change that list, and save it as a new template.'}</div>
            <div className='ml-sheet__footer'>
                <button
                    className='ml-btn ml-btn--danger-ghost'
                    onClick={onDelete}
                >
                    {'Delete template'}
                </button>
            </div>
        </Sheet>
    );
}

// SaveTemplateSheet saves a list as a template for everyone in the team.
export function SaveTemplateSheet({detail, onClose}: {detail: ListDetail; onClose: () => void}) {
    const [name, setName] = useState(detail.list.title);
    const [description, setDescription] = useState('');
    const [includeItems, setIncludeItems] = useState(false);
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState<Template | null>(null);
    const itemCount = detail.items.length;

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) {
            return;
        }
        setBusy(true);
        const template = await saveTemplate(detail.list.id, name.trim(), description.trim(), includeItems && itemCount > 0);
        setBusy(false);
        if (template) {
            setSaved(template);
        }
    };

    if (saved) {
        return (
            <Sheet
                title='Template saved'
                onClose={onClose}
            >
                <p>{`“${saved.name}” is saved. Everyone in the team can now pick it when they make a new list.`}</p>
                <div className='ml-muted'>{columnsLine(saved)}</div>
                <button
                    className='ml-btn ml-btn--primary'
                    onClick={onClose}
                >
                    {'Done'}
                </button>
            </Sheet>
        );
    }

    return (
        <Sheet
            title='Save as template'
            onClose={onClose}
        >
            <form
                className='ml-form'
                onSubmit={submit}
            >
                <div className='ml-field'>
                    <div className='ml-field__label'>{'Template name'}</div>
                    <input
                        className='ml-input'
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                </div>
                <div className='ml-field'>
                    <div className='ml-field__label'>{'Description (optional)'}</div>
                    <input
                        className='ml-input'
                        value={description}
                        placeholder='What this template is for'
                        maxLength={200}
                        onChange={(e) => setDescription(e.target.value)}
                    />
                </div>
                <div className='ml-muted'>{`Saves the ${detail.columns.length === 1 ? 'column' : `${detail.columns.length} columns`} and their options.`}</div>
                {itemCount > 0 && (
                    <label className='ml-check'>
                        <input
                            type='checkbox'
                            checked={includeItems}
                            onChange={(e) => setIncludeItems(e.target.checked)}
                        />
                        <span>
                            {'Also save items'}
                            <span className='ml-muted'>{` (${itemCount})`}</span>
                            <span className='ml-check__note'>{'Titles, text and choices are kept. Statuses start again from the first choice; checkboxes, people, dates and photos are left empty.'}</span>
                        </span>
                    </label>
                )}
                <div className='ml-muted'>{'Everyone in the team will be able to use it.'}</div>
                <button
                    className='ml-btn ml-btn--primary'
                    type='submit'
                    disabled={busy || !name.trim()}
                >
                    {busy ? 'Saving…' : 'Save template'}
                </button>
            </form>
        </Sheet>
    );
}
