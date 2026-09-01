import { updateAttr, updateClass, updateStyle } from '../dom/updater';
import { defineBoundWriterDirective } from './define-bound-writer';

export const rzAttr = defineBoundWriterDirective('attr', (el, key, val) => {
  if (key === 'class') {
    updateClass(el, val);
  } else if (key === 'style') {
    updateStyle(el, val);
  } else {
    updateAttr(el, key, val);
  }
});
