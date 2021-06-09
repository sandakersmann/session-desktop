import React, { Dispatch, useEffect, useState } from 'react';
import { SessionIconButton, SessionIconSize, SessionIconType } from './icon';
import { Avatar, AvatarSize } from '../Avatar';
import { darkTheme, lightTheme } from '../../state/ducks/SessionTheme';
import { SessionToastContainer } from './SessionToastContainer';
import { ConversationController } from '../../session/conversations';
import { UserUtils } from '../../session/utils';
import { syncConfigurationIfNeeded } from '../../session/utils/syncUtils';
import { DAYS, MINUTES } from '../../session/utils/Number';
import {
  generateAttachmentKeyIfEmpty,
  getItemById,
  hasSyncedInitialConfigurationItem,
} from '../../data/data';
import { OnionPaths } from '../../session/onions';
import { getMessageQueue } from '../../session/sending';
import { clearSessionsAndPreKeys } from '../../util/accountManager';
import { useDispatch, useSelector } from 'react-redux';
import { getOurNumber } from '../../state/selectors/user';
import {
  getOurPrimaryConversation,
  getUnreadMessageCount,
} from '../../state/selectors/conversations';
import { getTheme } from '../../state/selectors/theme';
import { applyTheme } from '../../state/ducks/theme';
import { getFocusedSection } from '../../state/selectors/section';
import { useInterval } from '../../hooks/useInterval';
import { clearSearch } from '../../state/ducks/search';
import { showLeftPaneSection } from '../../state/ducks/section';

import { cleanUpOldDecryptedMedias } from '../../session/crypto/DecryptedAttachmentsManager';
import { OpenGroupManagerV2 } from '../../opengroup/opengroupV2/OpenGroupManagerV2';
import { loadDefaultRooms } from '../../opengroup/opengroupV2/ApiUtil';
import { forceRefreshRandomSnodePool } from '../../session/snode_api/snodePool';
import { SwarmPolling } from '../../session/snode_api/swarmPolling';
import _, { divide } from 'lodash';
import { ActionPanelOnionStatusLight, OnionPathModal } from '../OnionStatusDialog';
import { EditProfileDialog } from '../EditProfileDialog';
import { StateType } from '../../state/reducer';
import { updateConfirmModal } from "../../state/ducks/modalDialog";
import { useInView } from 'react-intersection-observer';
import { SessionConfirm } from './SessionConfirm';

// tslint:disable-next-line: no-import-side-effect no-submodule-imports

export enum SectionType {
  Profile,
  Message,
  Contact,
  Channel,
  Settings,
  Moon,
  PathIndicator,
}

const Section = (props: {
  setModal?: any;
  type: SectionType;
  avatarPath?: string;
}) => {
  const ourNumber = useSelector(getOurNumber);
  const unreadMessageCount = useSelector(getUnreadMessageCount);
  const theme = useSelector(getTheme);
  const dispatch = useDispatch();
  const { setModal, type, avatarPath } = props;

  const focusedSection = useSelector(getFocusedSection);
  const isSelected = focusedSection === props.type;


  const handleModalClose = () => {
    setModal(null);
  }

  const handleClick = () => {
    /* tslint:disable:no-void-expression */
    if (type === SectionType.Profile) {
      // window.showEditProfileDialog();
      console.log("edit profile");

      // window.inboxStore?.dispatch(updateConfirmModal({ title: "title test" }));

      dispatch(updateConfirmModal({ title: "title test" }));

      // setModal(<EditProfileDialog2 onClose={() => setModal(null)}></EditProfileDialog2>);
      // setModal(<EditProfileDialog onClose={handleModalClose} theme={theme} ></EditProfileDialog>);
    } else if (type === SectionType.Moon) {
      const themeFromSettings = window.Events.getThemeSetting();
      const updatedTheme = themeFromSettings === 'dark' ? 'light' : 'dark';
      window.setTheme(updatedTheme);

      const newThemeObject = updatedTheme === 'dark' ? darkTheme : lightTheme;
      dispatch(applyTheme(newThemeObject));
    } else if (type === SectionType.PathIndicator) {
      // Show Path Indicator Modal
      setModal(<OnionPathModal onClose={handleModalClose}></OnionPathModal>);
    } else {
      dispatch(clearSearch());
      dispatch(showLeftPaneSection(type));
    }
  };

  if (type === SectionType.Profile) {
    const conversation = ConversationController.getInstance().get(ourNumber);

    const profile = conversation?.getLokiProfile();
    const userName = (profile && profile.displayName) || ourNumber;
    return (
      <Avatar
        avatarPath={avatarPath}
        size={AvatarSize.XS}
        onAvatarClick={handleClick}
        name={userName}
        pubkey={ourNumber}
      />
    );
  }

  let iconColor = undefined;
  if (type === SectionType.PathIndicator) {
  }

  const unreadToShow = type === SectionType.Message ? unreadMessageCount : undefined;

  let iconType: SessionIconType;
  switch (type) {
    case SectionType.Message:
      iconType = SessionIconType.ChatBubble;
      break;
    case SectionType.Contact:
      iconType = SessionIconType.Users;
      break;
    case SectionType.Settings:
      iconType = SessionIconType.Gear;
      break;
    case SectionType.Moon:
      iconType = SessionIconType.Moon;
      break;
    default:
      iconType = SessionIconType.Moon;
  }

  return (
    <>
      {type === SectionType.PathIndicator ?
        <ActionPanelOnionStatusLight
          handleClick={handleClick}
          isSelected={isSelected}
        />
        :
        <SessionIconButton
          iconSize={SessionIconSize.Medium}
          iconType={iconType}
          iconColor={iconColor}
          notificationCount={unreadToShow}
          onClick={handleClick}
          isSelected={isSelected}
          theme={theme}
        />
      }
    </>
  );
};

const showResetSessionIDDialogIfNeeded = async () => {
  const userED25519KeyPairHex = await UserUtils.getUserED25519KeyPair();
  if (userED25519KeyPairHex) {
    return;
  }

  window.showResetSessionIdDialog();
};

const cleanUpMediasInterval = MINUTES * 30;

const setupTheme = (dispatch: Dispatch<any>) => {
  const theme = window.Events.getThemeSetting();
  window.setTheme(theme);

  const newThemeObject = theme === 'dark' ? darkTheme : lightTheme;
  dispatch(applyTheme(newThemeObject));
};

// Do this only if we created a new Session ID, or if we already received the initial configuration message
const triggerSyncIfNeeded = async () => {
  const didWeHandleAConfigurationMessageAlready =
    (await getItemById(hasSyncedInitialConfigurationItem))?.value || false;
  if (didWeHandleAConfigurationMessageAlready) {
    await syncConfigurationIfNeeded();
  }
};

/**
 * This function is called only once: on app startup with a logged in user
 */
const doAppStartUp = (dispatch: Dispatch<any>) => {
  if (window.lokiFeatureFlags.useOnionRequests || window.lokiFeatureFlags.useFileOnionRequests) {
    // Initialize paths for onion requests
    void OnionPaths.getInstance().buildNewOnionPaths();
  }

  // init the messageQueue. In the constructor, we add all not send messages
  // this call does nothing except calling the constructor, which will continue sending message in the pipeline
  void getMessageQueue().processAllPending();
  void setupTheme(dispatch);

  // keep that one to make sure our users upgrade to new sessionIDS
  void showResetSessionIDDialogIfNeeded();
  // remove existing prekeys, sign prekeys and sessions
  // FIXME audric, make this in a migration so we can remove this line
  void clearSessionsAndPreKeys();

  // this generates the key to encrypt attachments locally
  void generateAttachmentKeyIfEmpty();
  void OpenGroupManagerV2.getInstance().startPolling();
  // trigger a sync message if needed for our other devices

  void triggerSyncIfNeeded();

  void loadDefaultRooms();

  // TODO: Investigate the case where we reconnect
  const ourKey = UserUtils.getOurPubKeyStrFromCache();
  SwarmPolling.getInstance().addPubkey(ourKey);
  SwarmPolling.getInstance().start();
};

/**
 * ActionsPanel is the far left banner (not the left pane).
 * The panel with buttons to switch between the message/contact/settings/theme views
 */
export const ActionsPanel = () => {
  const dispatch = useDispatch();
  const [startCleanUpMedia, setStartCleanUpMedia] = useState(false);
  const ourPrimaryConversation = useSelector(getOurPrimaryConversation);
  const [modal, setModal] = useState<any>(null);

  // this maxi useEffect is called only once: when the component is mounted.
  // For the action panel, it means this is called only one per app start/with a user loggedin
  useEffect(() => {
    void doAppStartUp(dispatch);
  }, []);

  // wait for cleanUpMediasInterval and then start cleaning up medias
  // this would be way easier to just be able to not trigger a call with the setInterval
  useEffect(() => {
    const timeout = global.setTimeout(() => setStartCleanUpMedia(true), cleanUpMediasInterval);

    return () => global.clearTimeout(timeout);
  }, []);

  useInterval(
    () => {
      cleanUpOldDecryptedMedias();
    },
    startCleanUpMedia ? cleanUpMediasInterval : null
  );

  if (!ourPrimaryConversation) {
    window.log.warn('ActionsPanel: ourPrimaryConversation is not set');
    return <></>;
  }

  useInterval(() => {
    void syncConfigurationIfNeeded();
  }, DAYS * 2);

  useInterval(() => {
    void forceRefreshRandomSnodePool();
  }, DAYS * 1);

  const formatLog = (s: any ) => {
    console.log("@@@@:: ", s);
  }


  // const confirmModalState = useSelector((state: StateType) => state);

  const confirmModalState = useSelector((state: StateType) => state.confirmModal);

  console.log('@@@ confirm modal state', confirmModalState);

  // formatLog(confirmModalState.modalState.title);

  formatLog(confirmModalState);

  // formatLog(confirmModalState2);
  
  return (
    <>
      {/* {modal ? modal : null} */}
      {/* { confirmModalState && confirmModalState.title ? <div>{confirmModalState.title}</div> : null} */}
      { confirmModalState ? <SessionConfirm {...confirmModalState} />: null}
      <div className="module-left-pane__sections-container">
        <Section
          // setModal={setModal}
          type={SectionType.Profile}
          avatarPath={ourPrimaryConversation.avatarPath}
        />
        <Section type={SectionType.Message} />
        <Section type={SectionType.Contact} />
        <Section type={SectionType.Settings} />

        <SessionToastContainer />

        <Section
          setModal={setModal}
          type={SectionType.PathIndicator} />
        <Section type={SectionType.Moon} />
      </div>
    </>
  );
};
