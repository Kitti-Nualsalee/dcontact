package io.dcontact.keycloak.account;

import java.util.List;
import org.keycloak.Config;
import org.keycloak.authentication.authenticators.conditional.ConditionalAuthenticator;
import org.keycloak.authentication.authenticators.conditional.ConditionalAuthenticatorFactory;
import org.keycloak.models.AuthenticationExecutionModel;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.provider.ProviderConfigProperty;

/** AC2 (#595): factory ของ {@link OrgMfaRequiredCondition} */
public class OrgMfaRequiredConditionFactory implements ConditionalAuthenticatorFactory {

  public static final String ID = "dc-org-mfa-required";
  public static final String NEGATE = "dc.negate";

  private static final AuthenticationExecutionModel.Requirement[] REQUIREMENTS = {
    AuthenticationExecutionModel.Requirement.REQUIRED,
    AuthenticationExecutionModel.Requirement.DISABLED
  };

  @Override
  public String getId() {
    return ID;
  }

  @Override
  public String getDisplayType() {
    return "Condition - organization requires 2FA";
  }

  @Override
  public String getHelpText() {
    return "True when the user belongs to an enabled organization with dc_mfa_required=true.";
  }

  @Override
  public boolean isConfigurable() {
    return true;
  }

  @Override
  public List<ProviderConfigProperty> getConfigProperties() {
    ProviderConfigProperty negate = new ProviderConfigProperty();
    negate.setName(NEGATE);
    negate.setLabel("Negate output");
    negate.setType(ProviderConfigProperty.BOOLEAN_TYPE);
    negate.setDefaultValue(false);
    negate.setHelpText("Match users whose organizations do not require 2FA.");
    return List.of(negate);
  }

  @Override
  public AuthenticationExecutionModel.Requirement[] getRequirementChoices() {
    return REQUIREMENTS;
  }

  @Override
  public boolean isUserSetupAllowed() {
    return false;
  }

  @Override
  public ConditionalAuthenticator getSingleton() {
    return OrgMfaRequiredCondition.SINGLETON;
  }

  @Override
  public void init(Config.Scope config) {}

  @Override
  public void postInit(KeycloakSessionFactory factory) {}

  @Override
  public void close() {}
}
