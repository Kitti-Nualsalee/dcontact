package io.dcontact.keycloak.people;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.Immutable;
@Entity @Immutable @Table(name="DC_TENANT_PEOPLE_INVITATION_DISPATCH")
public class PeopleInvitationDispatch {
  @Id @Column(name="ID",length=64) public String id;
  @Column(name="STARTED_AT_EPOCH",nullable=false) public long startedAtEpoch;
}
