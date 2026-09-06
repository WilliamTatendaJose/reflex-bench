import './globals.css';
import { Analytics } from '@vercel/analytics/next';

export const metadata = {
  title: 'Reflex Bench',
  description: 'Five rounds, median wins. Cheat if you can — the wall of shame is public.',
};

export const viewport = { width: 'device-width', initialScale: 1, maximumScale: 1 };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
