import fs from 'node:fs';
import path from 'node:path';

const platform = process.env.CAPACITOR_PLATFORM_NAME;
if (platform && platform !== 'android') {
  process.exit(0);
}

const javaRoot = path.resolve('android/app/src/main/java');

if (!fs.existsSync(javaRoot)) {
  console.log('[android] MainActivity no disponible todavía; se omite el parche de SocialLogin.');
  process.exit(0);
}

function findMainActivity(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findMainActivity(full);
      if (found) return found;
    } else if (entry.isFile() && entry.name === 'MainActivity.java') {
      return full;
    }
  }
  return null;
}

const mainActivityPath = findMainActivity(javaRoot);

if (!mainActivityPath) {
  throw new Error('No se encontró android/app/src/main/java/**/MainActivity.java');
}

const current = fs.readFileSync(mainActivityPath, 'utf8');
const packageMatch = current.match(/^\s*package\s+([A-Za-z0-9_.]+)\s*;/m);

if (!packageMatch) {
  throw new Error(`No se pudo determinar el package de ${mainActivityPath}`);
}

const packageName = packageMatch[1];

const patched = `package ${packageName};

import android.content.Intent;
import android.util.Log;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginHandle;

import ee.forgr.capacitor.social.login.GoogleProvider;
import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;
import ee.forgr.capacitor.social.login.SocialLoginPlugin;

public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (
            requestCode >= GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MIN &&
            requestCode < GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MAX
        ) {
            PluginHandle pluginHandle = getBridge().getPlugin("SocialLogin");

            if (pluginHandle == null) {
                Log.i("Google Activity Result", "SocialLogin login handle is null");
                return;
            }

            Plugin plugin = pluginHandle.getInstance();

            if (!(plugin instanceof SocialLoginPlugin)) {
                Log.i("Google Activity Result", "SocialLogin plugin instance is not SocialLoginPlugin");
                return;
            }

            ((SocialLoginPlugin) plugin).handleGoogleLoginIntent(requestCode, data);
        }
    }

    @Override
    public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {}
}
`;

if (current === patched) {
  console.log(`[android] SocialLogin MainActivity ya estaba configurado: ${mainActivityPath}`);
  process.exit(0);
}

fs.writeFileSync(mainActivityPath, patched, 'utf8');
console.log(`[android] MainActivity configurado para scopes de Google: ${mainActivityPath}`);
