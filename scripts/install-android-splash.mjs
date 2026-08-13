import fs from 'node:fs';
import path from 'node:path';

const targetRoot = path.resolve('android/app/src/main/res');
const logoSource = path.resolve('resources/icon.png');
const stylesPath = path.join(targetRoot, 'values', 'styles.xml');

if (!fs.existsSync(targetRoot)) {
  console.log('[android] Proyecto Android no disponible; se omite la pantalla de carga.');
  process.exit(0);
}
if (!fs.existsSync(logoSource)) {
  throw new Error(`No se encontró el logo HD en ${logoSource}`);
}

// Capacitor genera splash.png por orientación y densidad. Esos bitmaps se usan
// como fondos y Android los estira para llenar la ventana, deformando el logo.
// Se eliminan para que todas las versiones usen un único drawable centrado.
for (const dirent of fs.readdirSync(targetRoot, { withFileTypes: true })) {
  if (!dirent.isDirectory() || !dirent.name.startsWith('drawable')) continue;
  const stretchedSplash = path.join(targetRoot, dirent.name, 'splash.png');
  if (fs.existsSync(stretchedSplash)) fs.rmSync(stretchedSplash);
}

const drawableDir = path.join(targetRoot, 'drawable');
const drawableNodpiDir = path.join(targetRoot, 'drawable-nodpi');
const valuesDir = path.join(targetRoot, 'values');
fs.mkdirSync(drawableDir, { recursive: true });
fs.mkdirSync(drawableNodpiDir, { recursive: true });
fs.mkdirSync(valuesDir, { recursive: true });

fs.copyFileSync(logoSource, path.join(drawableNodpiDir, 'north_south_splash_logo.png'));

fs.writeFileSync(path.join(drawableDir, 'splash.xml'), `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="@color/north_south_splash_background" />
    <item
        android:width="280dp"
        android:height="280dp"
        android:gravity="center">
        <bitmap
            android:src="@drawable/north_south_splash_logo"
            android:gravity="fill"
            android:antialias="true"
            android:dither="true"
            android:filter="true" />
    </item>
</layer-list>
`);

fs.writeFileSync(path.join(valuesDir, 'north_south_splash.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="north_south_splash_background">#292727</color>
</resources>
`);

if (!fs.existsSync(stylesPath)) throw new Error(`No se encontró ${stylesPath}`);
const styles = fs.readFileSync(stylesPath, 'utf8');
const launchTheme = `    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="windowSplashScreenBackground">@color/north_south_splash_background</item>
        <item name="windowSplashScreenAnimatedIcon">@drawable/north_south_splash_logo</item>
        <item name="windowSplashScreenIconBackgroundColor">@android:color/transparent</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
        <item name="android:windowBackground">@drawable/splash</item>
    </style>`;
const launchThemePattern = /\s*<style name="AppTheme\.NoActionBarLaunch"[\s\S]*?<\/style>/;
if (!launchThemePattern.test(styles)) throw new Error('No se encontró AppTheme.NoActionBarLaunch para actualizar.');
const nextStyles = styles.replace(launchThemePattern, `\n\n${launchTheme}`);
fs.writeFileSync(stylesPath, nextStyles);

console.log('[android] Logo North South HD aplicado centrado y sin deformación.');
