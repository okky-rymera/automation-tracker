import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './app/Shell';

createRoot(document.getElementById('root')!).render(<App />);
