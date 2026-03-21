import './styles.css';
import { mountApp } from './app';

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) {
  throw new Error('App root element not found.');
}

void mountApp(root);
