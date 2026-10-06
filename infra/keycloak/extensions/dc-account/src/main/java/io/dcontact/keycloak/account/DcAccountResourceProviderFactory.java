package io.dcontact.keycloak.account;

import org.keycloak.Config;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.services.resource.RealmResourceProvider;
import org.keycloak.services.resource.RealmResourceProviderFactory;

/** AC2 (#595): ลงทะเบียน {@link DcAccountResource} ที่ {@code /realms/{realm}/dc-account} */
public class DcAccountResourceProviderFactory implements RealmResourceProviderFactory {

  public static final String ID = "dc-account";

  @Override
  public RealmResourceProvider create(KeycloakSession session) {
    return new RealmResourceProvider() {
      @Override
      public Object getResource() {
        return new DcAccountResource(session);
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
