import {useLayoutEffect, useRef} from 'react';

// useAutoGrow makes a textarea as tall as its text, starting from its rows attribute. A
// CSS max-height caps it, after which it scrolls.
export function useAutoGrow(value: string) {
    const ref = useRef<HTMLTextAreaElement>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) {
            return;
        }
        el.style.height = 'auto';

        // scrollHeight leaves out the border, which would otherwise show a scrollbar.
        const border = el.offsetHeight - el.clientHeight;
        el.style.height = `${el.scrollHeight + border}px`;
    }, [value]);
    return ref;
}
