import "./globals.css";
import ThemeProvider from "@/components/ThemeProvider";
import I18nProvider from "@/components/I18nProvider";
import Shell from "@/components/Shell";

const dbm = require("@/lib/db");
const { loadResources, languageMeta } = require("@/lib/i18n/loader");

// The chosen language is read from the registry DB below, at render time. Without
// this, Next prerenders these pages at BUILD time and bakes in whatever language the
// database held then — so switching to Korean left the server-rendered first paint in
// English until the client swapped it, and <html lang>/<dir> stayed wrong entirely.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Palworld Server Manager",
  description: "Provision, run, monitor and update multiple Palworld dedicated server worlds.",
  // Serve the favicon from public/icon.png. (Not via the app/icon.png convention,
  // which would collide with public/icon.png for the /icon.png URL and 500.)
  icons: { icon: "/icon.png" },
};

export default function RootLayout({ children }) {
  // Resolve the chosen language server-side and SSR its dictionary into first paint,
  // so non-English users never see a flash of untranslated English.
  const lng = dbm.getSetting("language", "en") || "en";
  const resources = loadResources(lng);
  const { dir } = languageMeta(lng);
  return (
    <html lang={lng} dir={dir} suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Nunito:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
        {/* Set theme before paint to avoid flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('pal-theme')||'dark';if(t==='dark')document.documentElement.classList.add('dark');}catch(e){document.documentElement.classList.add('dark');}})();`,
          }}
        />
      </head>
      <body>
        <I18nProvider lng={lng} resources={resources}>
          <ThemeProvider>
            <Shell>{children}</Shell>
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
