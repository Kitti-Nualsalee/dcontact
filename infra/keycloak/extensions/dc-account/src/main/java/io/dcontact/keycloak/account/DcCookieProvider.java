package io.dcontact.keycloak.account;

import jakarta.ws.rs.core.Cookie;
import jakarta.ws.rs.core.NewCookie;
import java.util.Map;
import java.util.Set;
import org.keycloak.cookie.CookiePath;
import org.keycloak.cookie.CookieProvider;
import org.keycloak.cookie.CookieType;
import org.keycloak.models.KeycloakContext;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.services.resources.RealmsResource;
import org.keycloak.utils.SecureContextResolver;

/**
 * R1 (#593) / AC6 (#599): cookie ของ realm ของ D-Contact ใช้ชื่อ {@code DC_*} แทน {@code KEYCLOAK_*}/{@code KC_*}
 *
 * <p>implement {@link CookieProvider} เอง (ไม่ extend {@code DefaultCookieProvider}, ไม่ใช้ reflection) โดยใช้เฉพาะ
 * getter สาธารณะของ {@link CookieType} — ชื่อใหม่คำนวณจากชื่อเดิมเป็น string จึงไม่ต้องสร้าง {@code CookieType} เอง:
 *
 * <ul>
 *   <li>path, SameSite, Secure, HttpOnly และอายุ ตามที่ Keycloak กำหนดไว้ใน {@code CookieType} ทุกประการ
 *       (ตรรกะเดียวกับ {@code DefaultCookieProvider} ของ 26.7.5: SameSite=None ที่ไม่ใช่ secure context ลดเป็น Lax)
 *   <li>ชนิด cookie ใหม่ที่ Keycloak เพิ่มภายหลังถูกเปลี่ยนชื่ออัตโนมัติ เพราะชื่อมาจาก {@code type.getName()}
 *   <li>ถ้า Keycloak เปลี่ยน API ที่ใช้ ({@code CookieType}, {@code CookiePath}, {@code RealmsResource.realmBaseUrl}, ...)
 *       คลาสนี้จะ <b>ไม่ compile</b> — gate {@code A1-F-KEYCLOAK-EXTENSION} จับได้ตอน upgrade ไม่ใช่ตอน deploy
 *   <li>ช่วง rollout: ผู้ใช้ที่ยังถือ cookie ชื่อเดิม อ่านค่าเดิมได้ แล้วชื่อเดิมถูกหมดอายุตอนเขียนชื่อใหม่
 *       (ไม่ส่งชื่อเดิมไปให้เบราว์เซอร์ที่ไม่มี)
 *   <li>เฉพาะ realm ที่กำหนด (ค่าเริ่มต้น {@code dcontact}) — realm master/admin console ใช้ชื่อเดิม
 * </ul>
 */
public class DcCookieProvider implements CookieProvider {

  private final KeycloakSession session;
  private final Set<String> realms;
  private final Map<String, Cookie> requestCookies;
  private final boolean secure;

  public DcCookieProvider(KeycloakSession session, Set<String> realms) {
    this.session = session;
    this.realms = realms;
    this.requestCookies = session.getContext().getHttpRequest().getHttpHeaders().getCookies();
    this.secure = SecureContextResolver.isSecureContext(session);
    // เหมือน DefaultCookieProvider: ล้าง cookie ของ Keycloak รุ่นเก่าที่ไม่ใช้แล้ว (หมดอายุเฉพาะที่เบราว์เซอร์ส่งมา)
    for (CookieType old : CookieType.OLD_UNUSED_COOKIES) {
      expire(old);
    }
  }

  /** {@code KEYCLOAK_SESSION} → {@code DC_SESSION}, {@code KC_RESTART} → {@code DC_RESTART}, อื่น ๆ → {@code DC_<ชื่อ>} */
  static String renamedName(String name) {
    return "DC_" + name.replaceFirst("^(KEYCLOAK_|KC_)", "");
  }

  private boolean applies() {
    RealmModel realm = session.getContext().getRealm();
    return realm != null && realms.contains(realm.getName());
  }

  /** ชื่อที่ใช้เขียน/อ่านจริง; cookie เก่าที่ Keycloak ลบอยู่แล้ว ({@code *_LEGACY}) คงชื่อเดิมเพื่อให้ลบถูกตัว */
  private String nameOf(CookieType type) {
    String name = type.getName();
    return name.endsWith("_LEGACY") || !applies() ? name : renamedName(name);
  }

  @Override
  public void set(CookieType type, String value) {
    Integer maxAge = type.getDefaultMaxAge();
    if (maxAge == null) {
      throw new IllegalArgumentException("Cookie type " + type.getName() + " has no default max age");
    }
    set(type, value, maxAge);
  }

  @Override
  public void set(CookieType type, String value, int maxAge) {
    String name = nameOf(type);
    NewCookie.SameSite sameSite = type.getScope().getSameSite();
    if (NewCookie.SameSite.NONE.equals(sameSite) && !secure) {
      sameSite = NewCookie.SameSite.LAX;
    }
    NewCookie cookie =
        new NewCookie.Builder(name)
            .version(1)
            .value(value)
            .path(path(type))
            .maxAge(maxAge)
            .secure(secure)
            .httpOnly(type.getScope().isHttpOnly())
            .sameSite(sameSite)
            .build();
    session.getContext().getHttpResponse().setCookieIfAbsent(cookie);
    retireOriginalName(type, name);
  }

  @Override
  public String get(CookieType type) {
    Cookie cookie = requestCookies.get(nameOf(type));
    // rollout: session ที่ login ก่อนเปิด provider ยังใช้ได้จนกว่าจะถูกเขียนใหม่ด้วยชื่อใหม่
    if (cookie == null && !nameOf(type).equals(type.getName())) {
      cookie = requestCookies.get(type.getName());
    }
    return cookie == null ? null : cookie.getValue();
  }

  @Override
  public void expire(CookieType type) {
    String name = nameOf(type);
    expireIfSent(type, name);
    retireOriginalName(type, name);
  }

  /** หมดอายุชื่อเดิมเฉพาะเมื่อเบราว์เซอร์ส่งมา — ผู้ใช้ใหม่ไม่เห็นชื่อเดิมใน response เลย */
  private void retireOriginalName(CookieType type, String writtenName) {
    if (!writtenName.equals(type.getName())) expireIfSent(type, type.getName());
  }

  private void expireIfSent(CookieType type, String name) {
    if (!requestCookies.containsKey(name)) return;
    NewCookie cookie =
        new NewCookie.Builder(name).version(1).path(path(type)).maxAge(0).build();
    session.getContext().getHttpResponse().setCookieIfAbsent(cookie);
  }

  /** ตรรกะเดียวกับ {@code CookiePathResolver} ของ Keycloak (คลาสนั้นเป็น package-private) */
  private String path(CookieType type) {
    KeycloakContext context = session.getContext();
    if (type.getPath() == CookiePath.REQUEST) {
      return context.getUri().getRequestUri().getRawPath();
    }
    return RealmsResource.realmBaseUrl(context.getUri())
        .path("/")
        .build(context.getRealm().getName())
        .getRawPath();
  }

  @Override
  public void close() {}
}
