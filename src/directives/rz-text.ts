import { updateText } from '../dom/updater';
import { defineBoundWriterDirective } from './define-bound-writer';

export const rzText = defineBoundWriterDirective('text', (el, _key, val) =>
  updateText(el, val),
);
