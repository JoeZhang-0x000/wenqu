import { isCollectionId } from '../../src/shared/types';

export interface Route {
  page: 'library' | 'works' | 'paper' | 'collections' | 'collection' | 'assistant';
  id?: string;
  tab?: string;
  item?: string;
  /** PDF page to open at. */
  at?: number;
}

export function parseRoute(hash: string): Route {
  const [path, query] = hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const [head, id] = path.split('/');
  const detail = { id, tab: params.get('tab') ?? undefined, item: params.get('item') ?? undefined };
  if (head === 'paper' && id) return { page: 'paper', ...detail, at: Number(params.get('at')) || undefined };
  if (head === 'collection' && id) return { page: 'collection', ...detail };
  if (head === 'collections') return { page: 'collections' };
  if (head === 'works') return { page: 'works' };
  if (head === 'assistant') return { page: 'assistant', id };
  return { page: 'library' };
}

function detailHref(kind: string, id: string, params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const query = search.toString();
  return `#/${kind}/${id}${query ? `?${query}` : ''}`;
}

export const paperHref = (id: string, tab?: string, item?: string, at?: number) => detailHref('paper', id, { tab, item, at });

/** Links to whatever owns a post or an episode: a paper or a collection. */
export const ownerHref = (id: string, tab?: string, item?: string) =>
  isCollectionId(id) ? detailHref('collection', id, { tab, item }) : paperHref(id, tab, item);
