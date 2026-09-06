import './globals.css';
import { Analytics } from '@vercel/analytics/next';

export const metadata = {
  title: 'Reflex Bench',
  description: 'Five rounds, median scored, every number checked before it reaches the board.',
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
