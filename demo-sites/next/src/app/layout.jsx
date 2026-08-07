export const metadata = {
  title: 'HTML-to-Storyblok Next Demo',
  description: 'Repository integration fixture for HTML-to-Storyblok.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
