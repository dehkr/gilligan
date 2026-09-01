import { updateProp } from '../dom/updater';
import { defineBoundWriterDirective } from './define-bound-writer';

export const rzProp = defineBoundWriterDirective('prop', (el, key, val) =>
  updateProp(el, key, val),
);
