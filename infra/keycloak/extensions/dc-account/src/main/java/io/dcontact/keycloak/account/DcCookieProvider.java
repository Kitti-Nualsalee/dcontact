package io.dcontact.keycloak.account;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.Set;
import org.keycloak.cookie.CookiePath;
import org.keycloak.cookie.CookieScope;
import org.keycloak.cookie.CookieType;
import org.keycloak.cookie.DefaultCookieProvider;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;

/**
 * R1 (#593) prototype: cookie ของ realm ของ D-Contact ใช้ชื่อ {@code DC_*} แทน {@code KEYCLOAK_*}/{@code KC_*}
 *
 * <ul>
 *   <li>สร้าง {@link CookieType} ชื่อใหม่ (path/scope/อายุเดิมทุกค่า) แล้วให้ {@link DefaultCookieProvider} ทำงานต่อ
 *       ตามเดิม — SameSite, Secure, HttpOnly และ path ยังมาจาก Keycloak
 *   <li>ชนิดใหม่ที่ Keycloak เพิ่มในเวอร์ชันถัดไปถูกเปลี่ยนชื่ออัตโนมัติ (อ่าน field ทั้งหมดของ CookieType)
 *   <li>ช่วง rollout: ถ้ายังมี cookie ชื่อเดิมในคำขอ อ่านค่าเดิมได้และหมดอายุชื่อเดิมทิ้ง — ไม่ส่งชื่อเดิมออกไป
 *       ถ้าเบราว์เซอร์ไม่มี
 *   <li>เฉพาะ realm ที่กำหนด (ค่าเริ่มต้น {@code dcontact}) — realm master/admin console ใช้ชื่อเดิม
 * </ul>
 */
public class DcCookieProvider extends DefaultCookieProvider {

  private final KeycloakSession session;
  private final Map<CookieType, CookieType> renamed;
  private final Set<String> realms;

  public DcCookieProvider(
      KeycloakSession session, Map<CookieType, CookieType> renamed, Set<String> realms) {
    super(session);
    this.session = session;
    this.renamed = renamed;
    this.realms = realms;
  }

  /** {@code KEYCLOAK_SESSION} → {@code DC_SESSION}, {@code KC_RESTART} → {@code DC_RESTART}, อื่น ๆ → {@code DC_<ชื่อ>} */
  static String renamedName(String name) {
    return "DC_" + name.replaceFirst("^(KEYCLOAK_|KC_)", "");
  }

  /** ทุก {@code public static final CookieType} ของ Keycloak → ชนิดชื่อใหม่ (ยกเว้น cookie เก่าที่ Keycloak ลบเองอยู่แล้ว) */
  static Map<CookieType, CookieType> renameAll() {
    Map<CookieType, CookieType> result = new IdentityHashMap<>();
    try {
      Constructor<CookieType> constructor =
          CookieType.class.getDeclaredConstructor(
              String.class, CookiePath.class, CookieScope.class, Integer.class);
      constructor.setAccessible(true);
      for (Field field : CookieType.class.getDeclaredFields()) {
        int modifiers = field.getModifiers();
        if (!Modifier.isStatic(modifiers) || field.getType() != CookieType.class) continue;
        CookieType original = (CookieType) field.get(null);
        if (original.getName().endsWith("_LEGACY")) continue;
        result.put(
            original,
            constructor.newInstance(
                renamedName(original.getName()),
                original.getPath(),
                original.getScope(),
                original.getDefaultMaxAge()));
      }
    } catch (ReflectiveOperationException failure) {
      // CookieType เปลี่ยนรูปแบบ (upgrade) — หยุดตั้งแต่บูต ดีกว่าออกชื่อเดิมเงียบ ๆ
      throw new IllegalStateException("ไม่สามารถเปลี่ยนชื่อ cookie ของ Keycloak รุ่นนี้ได้", failure);
    }
    return Collections.unmodifiableMap(result);
  }

  private boolean applies() {
    RealmModel realm = session.getContext().getRealm();
    return realm != null && realms.contains(realm.getName());
  }

  private CookieType target(CookieType type) {
    // constructor ของ DefaultCookieProvider เรียก expire() (ลบ cookie *_LEGACY) ก่อน field ของคลาสนี้ถูกตั้ง
    if (renamed == null) return type;
    return applies() ? renamed.getOrDefault(type, type) : type;
  }

  @Override
  public void set(CookieType type, String value) {
    CookieType target = target(type);
    super.set(target, value);
    retireLegacy(type, target);
  }

  @Override
  public void set(CookieType type, String value, int maxAge) {
    CookieType target = target(type);
    super.set(target, value, maxAge);
    retireLegacy(type, target);
  }

  @Override
  public String get(CookieType type) {
    CookieType target = target(type);
    String value = super.get(target);
    // rollout: session ที่ login ก่อนเปิด provider ยังใช้ได้จนกว่าจะถูกเขียนใหม่ด้วยชื่อใหม่
    return value == null && target != type ? super.get(type) : value;
  }

  @Override
  public void expire(CookieType type) {
    CookieType target = target(type);
    super.expire(target);
    retireLegacy(type, target);
  }

  /** หมดอายุชื่อเดิมเฉพาะเมื่อเบราว์เซอร์ส่งมา — ผู้ใช้ใหม่ไม่เห็นชื่อเดิมใน response เลย */
  private void retireLegacy(CookieType type, CookieType target) {
    if (target != type && super.get(type) != null) super.expire(type);
  }
}
