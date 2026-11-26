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
 * R1 (#593) / AC6 (#599): the cookies of the D-Contact realm use the names {@code DC_*} instead of {@code KEYCLOAK_*}/{@code KC_*}
 *
 * <p>implements {@link CookieProvider} itself (does not extend {@code DefaultCookieProvider}, no reflection) using only
 * the public getters of {@link CookieType} — the new name is computed from the old name as a string, so no {@code CookieType} has to be created:
 *
 * <ul>
 *   <li>path, SameSite, Secure, HttpOnly and lifetime follow what Keycloak defines in {@code CookieType} exactly
 *       (the same logic as {@code DefaultCookieProvider} of 26.7.5: SameSite=None outside a secure context is lowered to Lax)
 *   <li>new cookie types that Keycloak adds later are renamed automatically, because the name comes from {@code type.getName()}
 *   <li>if Keycloak changes the API used ({@code CookieType}, {@code CookiePath}, {@code RealmsResource.realmBaseUrl}, ...)
 *       this class will <b>not compile</b> — the gate {@code A1-F-KEYCLOAK-EXTENSION} catches it at upgrade time, not at deploy time
 *   <li>during rollout: a user who still holds a cookie with the old name can have the old value read, and the old name is expired when the new name is written
 *       (the old name is not sent to a browser that does not have it)
 *   <li>only the configured realms (default {@code dcontact}) — the master realm/admin console keeps the original names
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
    // same as DefaultCookieProvider: clear the old cookies of previous Keycloak versions that are no longer used (expire only those the browser sent)
    for (CookieType old : CookieType.OLD_UNUSED_COOKIES) {
      expire(old);
    }
  }

  /** {@code KEYCLOAK_SESSION} → {@code DC_SESSION}, {@code KC_RESTART} → {@code DC_RESTART}, others → {@code DC_<name>} */
  static String renamedName(String name) {
    return "DC_" + name.replaceFirst("^(KEYCLOAK_|KC_)", "");
  }

  private boolean applies() {
    RealmModel realm = session.getContext().getRealm();
    return realm != null && realms.contains(realm.getName());
  }

  /** the name actually used to write/read; old cookies that Keycloak already deletes ({@code *_LEGACY}) keep their original name so the right one is deleted */
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
    // rollout: a session that logged in before the provider was enabled stays valid until it is rewritten with the new name
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

  /** expire the old name only when the browser sent it — a new user never sees the old name in the response */
  private void retireOriginalName(CookieType type, String writtenName) {
    if (!writtenName.equals(type.getName())) expireIfSent(type, type.getName());
  }

  private void expireIfSent(CookieType type, String name) {
    if (!requestCookies.containsKey(name)) return;
    NewCookie cookie =
        new NewCookie.Builder(name).version(1).path(path(type)).maxAge(0).build();
    session.getContext().getHttpResponse().setCookieIfAbsent(cookie);
  }

  /** the same logic as Keycloak's {@code CookiePathResolver} (that class is package-private) */
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
