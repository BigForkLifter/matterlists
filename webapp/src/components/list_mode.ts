import {createContext, useContext} from 'react';

// ListMode says where a list is shown: in the channel's sidebar, or on its own full page
// (opened from a link), which has no sidebar for threads.
export type ListMode = 'sidebar' | 'page';

export const ListModeContext = createContext<ListMode>('sidebar');

export const useListMode = () => useContext(ListModeContext);
