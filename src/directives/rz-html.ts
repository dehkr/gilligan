import { updateHtml } from '../dom/updater';
import { defineBoundWriterDirective } from './define-bound-writer';

export const rzHtml = defineBoundWriterDirective('html', (el, _key, val) =>
  updateHtml(el, val),
);
