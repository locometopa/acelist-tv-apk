package es.locometopa.acelisttv;

import android.app.UiModeManager;
import android.content.res.Configuration;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AceListNativoPlugin.class);
        super.onCreate(savedInstanceState);
        // En la tele, que la pantalla no se apague (en el móvil solo mientras se ve un canal, en el reproductor)
        UiModeManager modo = (UiModeManager) getSystemService(UI_MODE_SERVICE);
        if (modo != null && modo.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebSettings settings = getBridge().getWebView().getSettings();
            // El vídeo empieza solo, sin necesidad de pulsar sobre él
            settings.setMediaPlaybackRequiresUserGesture(false);
        }
    }
}
