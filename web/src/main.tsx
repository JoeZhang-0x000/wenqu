import { createRoot } from 'react-dom/client';
import { t } from '../../src/shared/i18n';
import 'katex/dist/katex.min.css';
import 'pdfjs-dist/web/pdf_viewer.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
