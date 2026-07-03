export const CARD_LAYOUT_MAX_COLS = 48;

export type LayoutKind = 'table' | 'cards';

export function pickLayout(cols: number): LayoutKind {
  return cols < CARD_LAYOUT_MAX_COLS ? 'cards' : 'table';
}
