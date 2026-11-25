package io.dcontact.keycloak.account;

import org.keycloak.Config;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.services.resource.AccountResourceProvider;
import org.keycloak.services.resource.AccountResourceProviderFactory;

/**
 * AC6 (#599): the HTML page of {@code /realms/dcontact/account/} (the identity provider's Account Console) is replaced by
 * {@link DcAccountLanding}, which sends users back to D-Contact — selected through the theme property
 * {@code accountResourceProvider=dc-account-landing} of the account theme {@code dcontact}
 *
 * <p>This is an extension point that Keycloak exposes to themes; the Account REST API ({@code Accept: application/json})
 * does not pass through it, so it does not affect {@code @d-contact/i18n}, which switches language over REST
 */
public class DcAccountLandingProviderFactory implements AccountResourceProviderFactory {

  public static final String ID = "dc-account-landing";

  @Override
  public AccountResourceProvider create(KeycloakSession session) {
    return new AccountResourceProvider() {
      @Override
      public Object getResource() {
        return new DcAccountLanding(session);
      }

      @Override
      public void close() {}
    };
  }

  @Override
  public void init(Config.Scope config) {}

  @Override
  public void postInit(KeycloakSessionFactory factory) {}

  @Override
  public void close() {}

  @Override
  public String getId() {
    return ID;
  }
}
