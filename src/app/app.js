'use strict';

const React                     = require('react');
const ReactDOM                  = require('react-dom');
const Router                    = require('react-router-component');
const Locations                 = Router.Locations;
const Location                  = Router.Location;
const NotFound                  = Router.NotFound;
const CSSTransitionGroup        = require('react-transition-group/CSSTransitionGroup');
const adapter                   = require('webrtc-adapter');
const sylkrtc                   = require('sylkrtc');
const debug                     = require('debug');

const RegisterBox          = require('./components/RegisterBox');
const ReadyBox             = require('./components/ReadyBox');
const Call                 = require('./components/Call');
const CallByUriBox         = require('./components/CallByUriBox');
const Conference           = require('./components/Conference');
const ConferenceByUriBox   = require('./components/ConferenceByUriBox');
const AudioPlayer          = require('./components/AudioPlayer');
const ErrorPanel           = require('./components/ErrorPanel');
const FooterBox            = require('./components/FooterBox');
const StatusBox            = require('./components/StatusBox');
const IncomingCallModal    = require('./components/IncomingModal');
const NotificationCenter   = require('./components/NotificationCenter');
const LoadingScreen        = require('./components/LoadingScreen');
const NavigationBar        = require('./components/NavigationBar');

const utils     = require('./utils');
const config    = require('./config');
const storage   = require('./storage');
const history   = require('./history');

// attach debugger to the window for console access
window.blinkDebugger = debug;

const DEBUG = debug('blinkrtc:App');

// Application modes
const MODE_NORMAL           = Symbol('mode-normal');
const MODE_GUEST_CALL       = Symbol('mode-guest-call');
const MODE_GUEST_CONFERENCE = Symbol('mode-guest-conference');


class Blink extends React.Component {
    constructor() {
        super();
        this._initialSstate = {
            accountId: '',
            password: '',
            displayName: '',
            account: null,
            registrationState: null,
            currentCall: null,
            connection: null,
            inboundCall: null,
            showIncomingModal: false,
            status: null,
            targetUri: '',
            loading: null,
            mode: MODE_NORMAL,
            localMedia: null,
            history: []
        };
        this.state = Object.assign({}, this._initialSstate);

        this.__notificationCenter = null;

        // ES6 classes no longer autobind
        [
            'connectionStateChanged',
            'registrationStateChanged',
            'callStateChanged',
            'inboundCallStateChanged',
            'handleCallByUri',
            'handleConferenceByUri',
            'handleRegistration',
            'startCall',
            'startConference',
            'answerCall',
            'rejectCall',
            'hangupCall',
            'outgoingCall',
            'incomingCall',
            'missedCall',
            'conferenceInvite',
            'notificationCenter',
            'escalateToConference',
            'login',
            'logout',
            'ready',
            'call',
            'callByUri',
            'conference',
            'conferenceByUri',
            'notSupported',
            'checkRoute',
            'main'
        ].forEach((name) => {
            this[name] = this[name].bind(this);
        });
        this.participantsToInvite = null;
        this.redirectTo = null;
        this.prevPath = null;
        this.shouldUseHashRouting = false;
        this.managedConference = false;
    }

    get _notificationCenter() {
        // getter to lazy-load the NotificationCenter ref
        if (!this.__notificationCenter) {
            this.__notificationCenter = this.refs.notificationCenter;
        }
        return this.__notificationCenter;
    }

    componentWillMount() {
        storage.initialize();

        if (window.location.hash.startsWith('#!/')) {
            this.redirectTo = window.location.hash.replace('#!', '');
        } else {
            // Disallowed routes, they will rendirect to /login
            const disallowedRoutes = new Set(['/', '/ready','/call']);

            if (disallowedRoutes.has(window.location.pathname)) {
                this.redirectTo = '/login';
            }

            if (/^\/conference\/?$/g.test(window.location.pathname)) {
                this.redirectTo = `/conference/${utils.generateSillyName()}`;
            }

        }

        // Check if we should use hash routing
        if (typeof window.process !== 'undefined') {
            if (window.process.versions.electron !== '') {
                this.shouldUseHashRouting = true;
            }
        }
        history.load().then((entries) => {
            if (entries) {
                this.setState({history: entries});
            }
        });
    }

    componentDidMount() {
        if (!window.RTCPeerConnection) {
            setTimeout(() => {
                this.refs.router.navigate('/not-supported');
            });
        }

        if (this.shouldUseHashRouting) {
            setTimeout(() => {
                this.refs.router.navigate('/login');
            });
        }
        // prime the ref
        DEBUG('NotificationCenter ref: %o', this._notificationCenter);
    }

    connectionStateChanged(oldState, newState) {
        DEBUG(`Connection state changed! ${oldState} -> ${newState}`);
        switch (newState) {
            case 'closed':
                this.setState({connection: null});
                break;
            case 'ready':
                this.processRegistration(this.state.accountId, this.state.password, this.state.displayName);
                break;
            case 'disconnected':
                this.refs.audioPlayerOutbound.stop();
                this.refs.audioPlayerInbound.stop();

                if (this.state.localMedia) {
                    sylkrtc.utils.closeMediaStream(this.state.localMedia);
                }

                if (this.state.currentCall) {
                    this.state.currentCall.removeListener('stateChanged', this.callStateChanged);
                    this.state.currentCall.terminate();
                }

                if (this.state.inboundCall && this.state.inboundCall !== this.state.currentCall) {
                    this.state.inboundCall.removeListener('stateChanged', this.inboundCallStateChanged);
                    this.state.inboundCall.terminate();
                }

                this.setState({
                    account:null,
                    registrationState: null,
                    loading: 'Disconnected, reconnecting...',
                    showIncomingModal: false,
                    currentCall: null,
                    inboundCall: null,
                    localMedia: null
                });
                break;
            default:
                this.setState({loading: 'Connecting...'});
                break;
        }
    }

    notificationCenter() {
        return this._notificationCenter;
    }

    registrationStateChanged(oldState, newState, data) {
        DEBUG('Registration state changed! ' + newState);
        this.setState({registrationState: newState});
        if (newState === 'failed') {
            let reason = data.reason;
            if (reason.match(/904/)) {
                // Sofia SIP: WAT
                reason = 'Bad account or password';
            } else {
                reason = 'Connection failed';
            }
            this.setState({
                loading     : null,
                status      : {
                    msg   : 'Sign In failed: ' + reason,
                    level : 'danger'
                }
            });
        } else if (newState === 'registered') {
            this.setState({loading: null});
            this.refs.router.navigate('/ready');
            return;
        } else {
            this.setState({status: null });
        }
    }

    callStateChanged(oldState, newState, data) {
        DEBUG(`Call state changed! ${oldState} -> ${newState}`);

        switch (newState) {
            case 'progress':
                this.refs.audioPlayerOutbound.play(true);
                break;
            case 'accepted':
                this.refs.audioPlayerOutbound.stop();
                this.refs.audioPlayerInbound.stop();
                break;
            case 'terminated':
                this.refs.audioPlayerOutbound.stop();
                this.refs.audioPlayerInbound.stop();
                this.refs.audioPlayerHangup.play();

                let callSuccesfull = false;
                let reason = data.reason;
                if (!reason || reason.match(/200/)) {
                    reason = 'Hangup';
                    callSuccesfull = true;
                } else if (reason.match(/404/)) {
                    reason = 'User not found';
                } else if (reason.match(/408/)) {
                    reason = 'Timeout';
                } else if (reason.match(/480/)) {
                    reason = 'User not online';
                } else if (reason.match(/486/) || reason.match(/60[036]/)) {
                    reason = 'Busy';
                } else if (reason.match(/487/)) {
                    reason = 'Cancelled';
                } else if (reason.match(/488/)) {
                    reason = 'Unacceptable media';
                } else if (reason.match(/5\d\d/)) {
                    reason = 'Server failure';
                } else if (reason.match(/904/)) {
                    // Sofia SIP: WAT
                    reason = 'Bad account or password';
                } else {
                    reason = 'Connection failed';
                }
                this._notificationCenter.postSystemNotification('Call Terminated', {body: reason, timeout: callSuccesfull ? 5 : 10});

                this.setState({
                    currentCall         : null,
                    targetUri           : callSuccesfull ? '' : this.state.targetUri,
                    showIncomingModal   : false,
                    inboundCall         : null,
                    localMedia          : null
                });
                this.participantsToInvite = null;

                this.refs.router.navigate('/ready');

                break;
            default:
                break;
        }
    }

    inboundCallStateChanged(oldState, newState, data) {
        DEBUG('Inbound Call state changed! ' + newState);
        if (newState === 'terminated') {
            this.setState({ inboundCall: null, showIncomingModal: false });
        }
    }

    handleCallByUri(displayName, targetUri) {
        const accountId = `${utils.generateUniqueId()}@${config.defaultGuestDomain}`;
        this.setState({
            accountId      : accountId,
            password       : '',
            displayName    : displayName,
            mode           : MODE_GUEST_CALL,
            targetUri      : utils.normalizeUri(targetUri, config.defaultDomain),
            loading        : 'Connecting...'
        });

        if (this.state.connection === null) {
            let connection = sylkrtc.createConnection({server: config.wsServer});
            connection.on('stateChanged', this.connectionStateChanged);
            this.setState({connection: connection});
        } else {
            DEBUG('Connection Present, try to register');
            this.processRegistration(accountId, '', displayName);
        }
    }

    handleConferenceByUri(displayName, targetUri) {
        const accountId = `${utils.generateUniqueId()}@${config.defaultGuestDomain}`;
        this.setState({
            accountId      : accountId,
            password       : '',
            displayName    : displayName,
            mode           : MODE_GUEST_CONFERENCE,
            targetUri      : targetUri,
            loading        : 'Connecting...'
        });

        if (this.state.connection === null) {
            let connection = sylkrtc.createConnection({server: config.wsServer});
            connection.on('stateChanged', this.connectionStateChanged);
            this.setState({connection: connection});
        } else {
            DEBUG('Connection Present, try to register');
            this.processRegistration(accountId, '', displayName);
        }
    }

    handleRegistration(accountId, password) {
        // Needed for ready event in connection
        this.setState({
            accountId : accountId,
            password  : password,
            mode      : MODE_NORMAL,
            loading   : 'Connecting...'
        });

        if (this.state.connection === null) {
            let connection = sylkrtc.createConnection({server: config.wsServer});
            connection.on('stateChanged', this.connectionStateChanged);
            this.setState({connection: connection});
        } else {
            DEBUG('Connection Present, try to register');
            this.processRegistration(accountId, password);
        }
    }

    processRegistration(accountId, password, displayName) {
        if (this.state.account !== null) {
            DEBUG('We already have an account, removing it');
            this.state.connection.removeAccount(this.state.account,
                (error) => {
                    if (error) {
                        DEBUG(error);
                    }
                    this.setState({account: null, registrationState: null});
                }
            );
        }

        const options = {
            account: accountId,
            password: password,
            displayName: displayName
        };
        const account = this.state.connection.addAccount(options, (error, account) => {
            if (!error) {
                account.on('outgoingCall', this.outgoingCall);
                account.on('conferenceCall', this.outgoingCall);
                switch (this.state.mode) {
                    case MODE_NORMAL:
                        account.on('registrationStateChanged', this.registrationStateChanged);
                        account.on('incomingCall', this.incomingCall);
                        account.on('missedCall', this.missedCall);
                        account.on('conferenceInvite', this.conferenceInvite);
                        this.setState({account: account});
                        this.state.account.register();
                        storage.set('account', {accountId: this.state.accountId, password: this.state.password});
                        break;
                    case MODE_GUEST_CALL:
                        this.setState({account: account, loading: null, registrationState: 'registered'});
                        DEBUG(`${accountId} (guest) signed in`);
                        // Start the call immediately, this is call started with "Call by URI"
                        this.startGuestCall(this.state.targetUri, {audio: true, video: true});
                        break;
                    case MODE_GUEST_CONFERENCE:
                        this.setState({account: account, loading: null, registrationState: 'registered'});
                        DEBUG(`${accountId} (conference guest) signed in`);
                        // Start the call immediately, this is call started with "Conference by URI"
                        this.startGuestConference(this.state.targetUri);
                        break;
                    default:
                        DEBUG(`Unknown mode: ${this.state.mode}`);
                        break;

                }
            } else {
                DEBUG('Add account error: ' + error);
                this.setState({loading: null, status: {msg: error.message, level:'danger'}});
            }
        });
    }

    getLocalMedia(mediaConstraints={audio: true, video: true}, nextRoute=null) {    // eslint-disable-line space-infix-ops
        DEBUG('getLocalMedia(), mediaConstraints=%o', mediaConstraints);
        const constraints = Object.assign({}, mediaConstraints);

        if (constraints.video === true) {
            if ((nextRoute === '/conference' ||  this.state.mode === MODE_GUEST_CONFERENCE) && navigator.userAgent.indexOf('Firefox') > 0) {
                constraints.video = {
                    'width': {
                        'ideal': 640
                    },
                    'height': {
                        'ideal': 480
                    }
                };
            } else {
                // ask for 720p video
                constraints.video = {
                    'width': {
                        'ideal': 1280
                    },
                    'height': {
                        'ideal': 720
                    }
                };
            }
        }

        DEBUG('getLocalMedia(), (modified) mediaConstraints=%o', constraints);

        this.loadScreenTimer = setTimeout(() => {
            this.setState({loading: 'Please allow access to your media devices'});
        }, 150);

        navigator.mediaDevices.getUserMedia(constraints)
            .then((localStream) => {
                clearTimeout(this.loadScreenTimer);
                this.setState({status: null, loading: null, localMedia: localStream});
                if (nextRoute !== null) {
                    this.refs.router.navigate(nextRoute);
                }
            })
            .catch((error) => {
                DEBUG('Access to local media failed: %o', error);
                clearTimeout(this.loadScreenTimer);
                this._notificationCenter.postSystemNotification('Access to media failed', {timeout: 10});
                this.setState({
                    loading: null
                });
            });
    }

    startCall(targetUri, options) {
        this.setState({targetUri: targetUri});
        this.addCallHistoryEntry(targetUri);
        this.getLocalMedia(Object.assign({audio: true, video: true}, options), '/call');
    }

    startGuestCall(targetUri, options) {
        this.setState({targetUri: targetUri});
        this.getLocalMedia(Object.assign({audio: true, video: true}, options));
    }

    answerCall() {
        this.setState({ showIncomingModal: false });
        if (this.state.inboundCall !== this.state.currentCall) {
            // terminate current call to switch to incoming one
            this.state.inboundCall.removeListener('stateChanged', this.inboundCallStateChanged);
            this.state.currentCall.removeListener('stateChanged', this.callStateChanged);
            this.state.currentCall.terminate();
            this.setState({currentCall: this.state.inboundCall, inboundCall: this.state.inboundCall, localMedia: null});
            this.state.inboundCall.on('stateChanged', this.callStateChanged);
        }
        this.getLocalMedia(this.state.inboundCall.mediaTypes, '/call');
    }

    rejectCall() {
        this.setState({showIncomingModal: false});
        this.state.inboundCall.terminate();
    }

    hangupCall() {
        if (this.state.currentCall != null) {
            this.state.currentCall.terminate();
        } else {
            // We have no call but we still want to cancel
            if (this.state.localMedia != null) {
                sylkrtc.utils.closeMediaStream(this.state.localMedia);
            }
            this.refs.router.navigate('/ready');
        }
    }

    escalateToConference(participants) {
        this.state.currentCall.removeListener('stateChanged', this.callStateChanged);
        this.setState({currentCall: null, localMedia: null});
        this.participantsToInvite = participants;
        this.state.currentCall.terminate();
        const uri = `${utils.generateSillyName()}@${config.defaultConferenceDomain}`;
        this.startConference(uri);
    }

    startConference(targetUri, managed=false) { // eslint-disable-line space-infix-ops
        this.setState({targetUri: targetUri});
        this.managedConference = managed;
        this.getLocalMedia({audio: true, video: true}, '/conference');
    }

    startGuestConference(targetUri) {
        this.setState({targetUri: targetUri});
        this.getLocalMedia({audio: true, video: true});
    }

    outgoingCall(call) {
        call.on('stateChanged', this.callStateChanged);
        this.setState({currentCall: call});
    }

    incomingCall(call, mediaTypes) {
        DEBUG('New incoming call from %s with %o', call.remoteIdentity, mediaTypes);
        if (!mediaTypes.audio && !mediaTypes.video) {
            call.terminate();
            return;
        }
        call.mediaTypes = mediaTypes;
        if (this.state.currentCall !== null) {
            // detect if we called ourselves
            if (this.state.currentCall.localIdentity.uri === call.remoteIdentity.uri) {
                DEBUG('Aborting call to myself');
                call.terminate();
                return;
            }
            this.setState({ showIncomingModal: true, inboundCall: call });
            call.on('stateChanged', this.inboundCallStateChanged);
        } else {
            this.refs.audioPlayerInbound.play(true);
            call.on('stateChanged', this.callStateChanged);
            this.setState({currentCall: call, inboundCall: call, showIncomingModal: true});
        }
        this._notificationCenter.postSystemNotification('Incoming call', {body: `From ${call.remoteIdentity.displayName || call.remoteIdentity.uri}`, timeout: 15, silent: false});
    }

    missedCall(data) {
        DEBUG('Missed call from ' + data.originator);
        this._notificationCenter.postSystemNotification('Missed call', {body: `From ${data.originator.displayName || data.originator.uri}`, timeout: 15, silent: false});
        this._notificationCenter.postMissedCall(data.originator, () => {
            if (this.state.currentCall !== null) {
                this.state.currentCall.removeListener('stateChanged', this.callStateChanged);
                this.setState({currentCall: null, targetUri: data.originator.uri, showIncomingModal: false, localMedia: null});
                this.state.currentCall.terminate();
            } else {
                this.setState({targetUri: data.originator.uri});
            }
            this.refs.router.navigate('/ready');
        });
    }

    conferenceInvite(data) {
        DEBUG('Conference invite from %o to %s', data.originator, data.room);
        this._notificationCenter.postSystemNotification('Conference invite', {body: `From ${data.originator.displayName || data.originator.uri} for room ${data.room}`, timeout: 15, silent: false});
        this._notificationCenter.postConferenceInvite(data.originator, data.room, () => {
            if (this.state.currentCall !== null) {
                this.state.currentCall.removeListener('stateChanged', this.callStateChanged);
                this.state.currentCall.terminate();
                this.setState({currentCall: null, showIncomingModal: false, localMedia: null});
            }
            setTimeout(() => {
                this.startConference(data.room);
            });
        });
    }

    addCallHistoryEntry(uri) {
        history.add(uri).then((entries) => {
            this.setState({history: entries});
        });
    }

    checkRoute(nextPath, navigation, match) {
        if (nextPath !== this.prevPath) {
            DEBUG(`Transition from ${this.prevPath} to ${nextPath}`);

            // Don't navigate if the app is not supported
            if (!window.RTCPeerConnection && nextPath !== '/not-supported') {
                this.refs.router.navigate('/not-supported');
                this.forceUpdate();
                return false;
            }

            // Press back in ready after a login, prevent initial navigation
            // don't deny if there is no registrationState (connection fail)
            if (this.prevPath === '/ready' && nextPath === '/login' && this.state.registrationState !== null) {
                DEBUG('Transition denied redirecting to /logout');
                this.refs.router.navigate('/logout');
                return false;

            // Press back in ready after a call
            } else if ((nextPath === '/call' || nextPath === '/conference') && this.state.localMedia === null && this.state.registrationState === 'registered') {
                return false;

            // Press back from within a call/conference, don't navigate terminate the call and
            // let termination take care of navigating
            } else if (nextPath === '/ready' && this.state.registrationState === 'registered' && this.state.currentCall !== null) {
                this.state.currentCall.terminate();
                return false;

            // Guest call ended, needed to logout and display msg and logout
            } else if (nextPath === '/ready' && (this.state.mode === MODE_GUEST_CALL || this.state.mode === MODE_GUEST_CONFERENCE)) {
                this.refs.router.navigate('/logout');
                this.forceUpdate();
            }
        }
        this.prevPath = nextPath;
    }

    render() {
        if (this.redirectTo !== null) {
            window.location.href = this.redirectTo;
            return false;
        }

        let loadingScreen;
        let incomingCallModal;
        let footerBox = <FooterBox />;

        if (this.state.loading !== null) {
            loadingScreen = <LoadingScreen text={this.state.loading} />;
        }
        if (this.state.showIncomingModal) {
            incomingCallModal = (
                    <IncomingCallModal
                        call = {this.state.inboundCall}
                        onAnswer = {this.answerCall}
                        onHangup = {this.rejectCall}
                    />
            );
        }
        if (this.state.localMedia) {
            footerBox = '';
        }
        return (
            <div>
                <NotificationCenter ref="notificationCenter" />
                {loadingScreen}
                {footerBox}
                <AudioPlayer ref="audioPlayerInbound" sourceFile="assets/sounds/inbound_ringtone.wav" />
                <AudioPlayer ref="audioPlayerOutbound" sourceFile="assets/sounds/outbound_ringtone.wav" />
                <AudioPlayer ref="audioPlayerHangup" sourceFile="assets/sounds/hangup_tone.wav" />
                <CSSTransitionGroup transitionName="incoming-modal" transitionEnterTimeout={300} transitionLeaveTimeout={300}>
                    {incomingCallModal}
                </CSSTransitionGroup>
                <Locations hash={this.shouldUseHashRouting} ref="router" onBeforeNavigation={this.checkRoute}>
                    <Location path="/"  handler={this.main} />
                    <Location path="/login" handler={this.login} />
                    <Location path="/logout" handler={this.logout} />
                    <Location path="/ready" handler={this.ready} />
                    <Location path="/call" handler={this.call} />
                    <Location path="/call/:targetUri" urlPatternOptions={{segmentValueCharset: 'a-zA-Z0-9-_ \.@'}} handler={this.callByUri} />
                    <Location path="/conference" handler={this.conference} />
                    <Location path="/conference/:targetUri" urlPatternOptions={{segmentValueCharset: 'a-zA-Z0-9-_~ %\.@'}}  handler={this.conferenceByUri} />
                    <Location path="/not-supported" handler={this.notSupported} />
                    <NotFound handler={this.notFound} />
                </Locations>
            </div>
        );
    }

    notSupported() {
        const errorMsg = (
            <span>
                This application works in a browser that supports WebRTC (like recent versions
                of <a href="https://www.google.com/chrome/browser/desktop/" target="_blank">Chrome</a> or <a href="https://www.mozilla.org/firefox/new/" target="_blank">Firefox</a>)
                or in the standalone <a href="http://sylkserver.com/download/" target="_blank">Sylk application.</a>
            </span>
        );
        return (
            <div>
                <ErrorPanel errorMsg={errorMsg} />
                <RegisterBox
                    registrationInProgress={false}
                    handleRegistration={() => {}}
                />
            </div>
        );
    }

    notFound() {
        const status = {
            title   : '404',
            message : 'Oops, the page your looking for can\'t found: ' + window.location.pathname,
            level   : 'danger',
            width   : 'large'
        }
        return (
            <StatusBox
                {...status}
            />
        );
    }

    ready() {
        if (this.state.registrationState !== 'registered') {
            setTimeout(() => {
                this.refs.router.navigate('/login');
            });
            return false;
        };
        return (
            <div>
                <NavigationBar
                    notificationCenter = {this.notificationCenter}
                    account = {this.state.account}
                    logout = {this.logout}
                />
                <ReadyBox
                    account   = {this.state.account}
                    startCall = {this.startCall}
                    startConference = {this.startConference}
                    targetUri = {this.state.targetUri}
                    history = {this.state.history}
                />
            </div>
        );
    }

    call() {
        if (this.state.registrationState !== 'registered') {
            setTimeout(() => {
                this.refs.router.navigate('/login');
            });
            return false;
        };
        return (
            <Call
                localMedia = {this.state.localMedia}
                account = {this.state.account}
                targetUri = {this.state.targetUri}
                currentCall = {this.state.currentCall}
                escalateToConference = {this.escalateToConference}
                hangupCall = {this.hangupCall}
            />
        )
    }

    callByUri(urlParameters) {

        // check if the uri contains a domain
        if (urlParameters.targetUri.indexOf('@') === -1) {
            const status = {
                title   : 'Invalid user',
                message : `Oops, the domain of the user is not set in '${urlParameters.targetUri}'`,
                level   : 'danger',
                width   : 'large'
            }
            return (
                <StatusBox
                    {...status}
                />
            );
        }
        return (
            <CallByUriBox
                handleCallByUri = {this.handleCallByUri}
                notificationCenter = {this.notificationCenter}
                targetUri = {urlParameters.targetUri}
                localMedia = {this.state.localMedia}
                account = {this.state.account}
                currentCall = {this.state.currentCall}
                hangupCall = {this.hangupCall}
            />
        );
    }

    conference() {
        if (this.state.registrationState !== 'registered') {
            setTimeout(() => {
                this.refs.router.navigate('/login');
            });
            return false;
        };
        return (
            <Conference
                notificationCenter = {this.notificationCenter}
                localMedia = {this.state.localMedia}
                account = {this.state.account}
                targetUri = {this.state.targetUri}
                currentCall = {this.state.currentCall}
                participantsToInvite = {this.participantsToInvite}
                hangupCall = {this.hangupCall}
                managed = {this.managedConference}
            />
        )
    }

    conferenceByUri(urlParameters) {
        const targetUri = utils.normalizeUri(urlParameters.targetUri, config.defaultConferenceDomain);
        const idx = targetUri.indexOf('@');
        const uri = {};
        const pattern = /^[A-Za-z0-9\-\_]+$/g;
        uri.user = targetUri.substring(0, idx);

        // check if the uri.user is valid
        if (!pattern.test(uri.user)) {
            const status = {
                title   : 'Invalid conference',
                message : `Oops, the conference ID is invalid: ${targetUri}`,
                level   : 'danger',
                width   : 'large'
            }
            return (
                <StatusBox
                    {...status}
                />
            );
        }

        return (
            <ConferenceByUriBox
                notificationCenter = {this.notificationCenter}
                handler = {this.handleConferenceByUri}
                targetUri = {targetUri}
                localMedia = {this.state.localMedia}
                account = {this.state.account}
                currentCall = {this.state.currentCall}
                hangupCall = {this.hangupCall}
            />
        );
    }

    login() {
        let registerBox;
        let statusBox;
        if (this.state.status !== null) {
            statusBox = (
                <StatusBox
                    message={this.state.status.msg}
                    level={this.state.status.level}
                />
            );
        }

        if (this.state.registrationState !== 'registered') {
            registerBox = (
                <RegisterBox
                    registrationInProgress = {this.state.registrationState !== null && this.state.registrationState !== 'failed'}
                    handleRegistration = {this.handleRegistration}
                />
            );
        }

        return (
            <div>
                {registerBox}
                {statusBox}
            </div>
        );
    }

    logout() {
        setTimeout(() => {
            if (this.state.registrationState !== null && this.state.mode === MODE_NORMAL) {
                this.state.account.unregister();
            }

            if (this.state.account !== null) {
                this.state.connection.removeAccount(this.state.account,
                    (error) => {
                        if (error) {
                            DEBUG(error);
                        }
                    }
                );
            }
            this.setState({account: null, registrationState: null, status: null});
            this.refs.router.navigate('/login');
        });
        return <div></div>;
    }

    main() {
        return (
            <div></div>
        );
    }
}


ReactDOM.render((<Blink />), document.getElementById('app'));
