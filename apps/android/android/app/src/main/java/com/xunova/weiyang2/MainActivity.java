package com.xunova.weiyang2;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

/** 打开就是你的服务器（capacitor.config.json 的 server.url）；另外接住“分享 → 未央”，第一次打开时问一次通知权限 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WeiyangShellPlugin.class);
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
        handleShare(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleShare(intent);
    }

    private void handleShare(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        PluginHandle h = bridge == null ? null : bridge.getPlugin("WeiyangShell");
        if (h != null) ((WeiyangShellPlugin) h.getInstance()).deliverShare(intent);
        setIntent(new Intent(Intent.ACTION_MAIN)); // 处理过了，转屏等重建时不再重复交给网页
    }
}
