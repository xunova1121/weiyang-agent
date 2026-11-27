package com.xunova.weiyang2;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;

/**
 * 网页（你的服务器）能用的几个手机功能，网页里是 Capacitor.Plugins.WeiyangShell：
 *  - notify：回复做完时弹通知（App 在前台时不弹）
 *  - saveFile：把文件存到手机的“下载”文件夹（App 里的网页没法直接下载）
 *  - 事件 shared：从别的 App“分享 → 未央”的文件和文字，交给网页上传
 */
@CapacitorPlugin(name = "WeiyangShell")
public class WeiyangShellPlugin extends Plugin {
    private static final String CHANNEL = "replies";
    private static final long MAX_FILE = 20L * 1024 * 1024; // 和服务器上传上限一样
    private static final long MAX_TOTAL = 40L * 1024 * 1024;
    private static final int MAX_FILES = 10;
    private boolean foreground = true;
    private int notifyId = 1;

    @Override
    public void load() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "回复提醒", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("未央回复好了时提醒你");
            getContext().getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
    }

    @Override
    protected void handleOnResume() { foreground = true; }

    @Override
    protected void handleOnPause() { foreground = false; }

    @SuppressLint("MissingPermission") // 上面已检查通知权限
    @PluginMethod
    public void notify(PluginCall call) {
        JSObject ret = new JSObject();
        Context ctx = getContext();
        boolean allowed = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        if (foreground || !allowed) {
            ret.put("shown", false);
            call.resolve(ret);
            return;
        }
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle(clip(call.getString("title", "未央"), 80))
            .setContentText(clip(call.getString("body", ""), 200))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);
        try {
            NotificationManagerCompat.from(ctx).notify(notifyId++, b.build());
            ret.put("shown", true);
        } catch (SecurityException e) {
            ret.put("shown", false);
        }
        call.resolve(ret);
    }

    /** 存到“下载/未央”里；name 只取文件名部分，data 是 base64 */
    @PluginMethod
    public void saveFile(PluginCall call) {
        String name = new File(call.getString("name", "文件")).getName().replaceAll("[\\\\/:*?\"<>|]", "_");
        String data = call.getString("data", "");
        String mime = call.getString("mime", "application/octet-stream");
        new Thread(() -> {
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                Context ctx = getContext();
                String where;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    v.put(MediaStore.Downloads.MIME_TYPE, mime);
                    v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/未央");
                    Uri uri = ctx.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) throw new Exception("存不进下载文件夹");
                    try (OutputStream out = ctx.getContentResolver().openOutputStream(uri)) { out.write(bytes); }
                    where = "下载/未央/" + name;
                } else {
                    // 安卓 9 及以下：存到 App 自己的下载目录（不用额外权限）
                    File dir = new File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "");
                    dir.mkdirs();
                    File f = new File(dir, name);
                    try (FileOutputStream out = new FileOutputStream(f)) { out.write(bytes); }
                    where = f.getAbsolutePath();
                }
                JSObject ret = new JSObject();
                ret.put("path", where);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("保存失败：" + e.getMessage());
            }
        }).start();
    }

    /** MainActivity 收到“分享”时调用：读出文件交给网页（网页还没打开时先留着，等网页来取） */
    void deliverShare(Intent intent) {
        new Thread(() -> {
            JSObject data = new JSObject();
            JSArray files = new JSArray();
            ArrayList<Uri> uris = new ArrayList<>();
            if (Intent.ACTION_SEND.equals(intent.getAction())) {
                Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (u != null) uris.add(u);
            } else {
                ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null) uris.addAll(list);
            }
            long total = 0;
            int skipped = 0;
            for (Uri u : uris) {
                if (files.length() >= MAX_FILES) { skipped++; continue; }
                try {
                    String name = displayName(u);
                    byte[] bytes = readAll(u, MAX_FILE);
                    if (bytes == null || total + bytes.length > MAX_TOTAL) { skipped++; continue; }
                    total += bytes.length;
                    JSObject f = new JSObject();
                    f.put("name", name);
                    f.put("type", getContext().getContentResolver().getType(u));
                    f.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                    files.put(f);
                } catch (Exception e) {
                    skipped++;
                }
            }
            data.put("files", files);
            data.put("skipped", skipped);
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text != null) data.put("text", clip(text, 20000));
            notifyListeners("shared", data, true);
        }).start();
    }

    private String displayName(Uri u) {
        try (Cursor c = getContext().getContentResolver().query(u, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return new File(n).getName();
            }
        } catch (Exception ignored) { /* 拿不到名字就用默认的 */ }
        return "分享的文件";
    }

    /** 读整个文件；超过上限返回 null */
    private byte[] readAll(Uri u, long max) throws Exception {
        try (InputStream in = getContext().getContentResolver().openInputStream(u)) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            long n = 0;
            int r;
            while ((r = in.read(buf)) > 0) {
                n += r;
                if (n > max) return null;
                out.write(buf, 0, r);
            }
            return out.toByteArray();
        }
    }

    private static String clip(String s, int n) {
        if (s == null) return "";
        return s.length() > n ? s.substring(0, n) + "…" : s;
    }
}
