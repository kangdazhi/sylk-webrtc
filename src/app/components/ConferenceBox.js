'use strict';

const React                     = require('react');
const PropTypes                 = require('prop-types');
const CSSTransitionGroup        = require('react-transition-group/CSSTransitionGroup');
const ReactMixin                = require('react-mixin');
const ReactBootstrap            = require('react-bootstrap');
const Popover                   = ReactBootstrap.Popover;
const OverlayTrigger            = ReactBootstrap.OverlayTrigger;
const sylkrtc                   = require('sylkrtc');
const classNames                = require('classnames');
const debug                     = require('debug');
const moment                    = require('moment');
const momentFormat              = require('moment-duration-format');

const config                    = require('../config');
const utils                     = require('../utils');
const FullscreenMixin           = require('../mixins/FullScreen');
const AudioPlayer               = require('./AudioPlayer');
const ConferenceCarousel        = require('./ConferenceCarousel');
const ConferenceParticipant     = require('./ConferenceParticipant');
const ConferenceParticipantSelf = require('./ConferenceParticipantSelf');
const InviteParticipantsModal   = require('./InviteParticipantsModal');


const DEBUG = debug('blinkrtc:ConferenceBox');


class ConferenceBox extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            callOverlayVisible: true,
            audioMuted: false,
            videoMuted: false,
            autoRotate: true,
            participants: props.call.participants.slice(),
            currentLargeVideo: {
                stream: null,
                isLocal: false,
                hasVideo: false
            },
            showInviteModal: false,
            shareOverlayVisible: false
        };

        const friendlyName = this.props.remoteIdentity.split('@')[0];
        if (window.location.origin.startsWith('file://')) {
            this.callUrl = `${config.publicUrl}/conference/${friendlyName}`;
        } else {
            this.callUrl = `${window.location.origin}/conference/${friendlyName}`;
        }

        const emailMessage  = `You can join me in the conference using a Web browser at ${this.callUrl} ` +
                             'or by using the freely available Sylk WebRTC client app at http://sylkserver.com';
        const subject       = 'Join me, maybe?';

        this.emailLink = `mailto:?subject=${encodeURI(subject)}&body=${encodeURI(emailMessage)}`;

        this.rotateTimer = null;
        this.callDuration = null;
        this.callTimer = null;
        this.overlayTimer = null;

        // ES6 classes no longer autobind
        [
            'showOverlay',
            'handleFullscreen',
            'muteAudio',
            'muteVideo',
            'hangup',
            'onParticipantJoined',
            'onParticipantLeft',
            'onParticipantStateChanged',
            'onParticipantActive',
            'onVideoSelected',
            'maybeSwitchLargeVideo',
            'handleClipboardButton',
            'handleShareOverlayEntered',
            'handleShareOverlayExited',
            'toggleAutoRotate',
            'toggleInviteModal',
            'preventOverlay'
        ].forEach((name) => {
            this[name] = this[name].bind(this);
        });
    }

    componentDidMount() {
        for (let p of this.state.participants) {
            p.on('stateChanged', this.onParticipantStateChanged);
            p.attach();
        }
        this.props.call.on('participantJoined', this.onParticipantJoined);
        this.props.call.on('participantLeft', this.onParticipantLeft);

        this.armOverlayTimer();
        this.startCallTimer();

        // attach to ourselves first if there are no other participants
        if (this.state.participants.length === 0) {
            setTimeout(() => {
                const item = {
                    stream: this.props.call.getLocalStreams()[0],
                    identity: this.props.call.localIdentity
                };
                this.selectVideo(item);
            });
        }
    }

    componentWillUnmount() {
        clearTimeout(this.overlayTimer);
        clearTimeout(this.callTimer);

        this.exitFullscreen();

        this.refs.largeVideo.src = '';
    }

    onParticipantJoined(p) {
        DEBUG(`Participant joined: ${p.identity}`);
        this.refs.audioPlayerParticipantJoined.play();
        p.on('stateChanged', this.onParticipantStateChanged);
        p.attach();
        this.setState({
            participants: this.state.participants.concat([p])
        });
    }

    onParticipantLeft(p) {
        DEBUG(`Participant left: ${p.identity}`);
        this.refs.audioPlayerParticipantLeft.play();
        p.detach();
        const participants = this.state.participants.slice();
        const idx = participants.indexOf(p);
        if (idx !== -1) {
            participants.splice(idx, 1);
            this.setState({
                participants: participants
            });
        }
    }

    onParticipantStateChanged(oldState, newState) {
        if (newState === 'established' || newState === null) {
            this.maybeSwitchLargeVideo();
        }
    }

    onVideoSelected(item) {
        this.setState({autoRotate: false});
        this.selectVideo(item);
    }

    selectVideo(item) {
        DEBUG('Switching video to: %o', item);
        if (item.stream) {
            if (item.stream !== this.state.currentLargeVideo.stream) {
                const isLocal = item.stream === this.props.call.getLocalStreams()[0];
                const hasVideo = item.stream.getVideoTracks().length > 0;
                this.setState({currentLargeVideo: {stream: item.stream, isLocal: isLocal, hasVideo: hasVideo}});
                sylkrtc.utils.attachMediaStream(item.stream, this.refs.largeVideo);
            }
        } else {
            this.setState({currentLargeVideo: {stream: null, isLocal: false, hasVideo: false}});
            this.refs.largeVideo.src = '';
        }
    }

    onParticipantActive(item) {
        DEBUG('Participant is active: %o', item);
        if (this.state.autoRotate) {
            if (this.rotateTimer === null) {
                this.selectVideo(item);
                this.rotateTimer = setTimeout(() => {
                    this.rotateTimer = null;
                }, 5000);
            }
        }
    }

    maybeSwitchLargeVideo() {
        // Switch the large video to another source, maybe.
        if (this.state.currentLargeVideo.stream == null ||
            !this.state.currentLargeVideo.stream.active ||
            this.state.currentLargeVideo.isLocal) {

            let done = false;
            for (let p of this.state.participants) {
                if (p.state !== 'established') {
                    continue;
                }
                const streams = p.streams;
                if (streams.length > 0 && streams[0].active && streams[0].getVideoTracks().length > 0) {
                    const item = {
                        stream: streams[0],
                        identity: p.identity
                    };
                    this.selectVideo(item);
                    done = true;
                    break;
                }
            }
            if (!done) {
                // none of the participants are eligible, show ourselves
                const item = {
                    stream: this.props.call.getLocalStreams()[0],
                    identity: this.props.call.localIdentity
                };
                this.selectVideo(item);
            }
        }
    }

    toggleAutoRotate(event) {
        event.preventDefault();
        this.setState({autoRotate: !this.state.autoRotate});
    }

    handleFullscreen(event) {
        event.preventDefault();
        this.toggleFullscreen(document.body);
    }

    handleClipboardButton() {
        utils.copyToClipboard(this.callUrl);
        this.props.notificationCenter().postSystemNotification('Join me, maybe?', {body: 'Link copied to the clipboard'});
        this.refs.shareOverlay.hide();
    }

    handleShareOverlayEntered() {
        // keep the buttons and overlay visible
        clearTimeout(this.overlayTimer);
        this.setState({shareOverlayVisible: true});
    }

    handleShareOverlayExited() {
        // re-arm the buttons and overlay timeout
        this.armOverlayTimer();
        this.setState({shareOverlayVisible: false});
    }

    preventOverlay(event) {
        // Stop the overlay when we are the thumbnail bar
        event.stopPropagation();
    }

    muteAudio(event) {
        event.preventDefault();
        const localStream = this.props.call.getLocalStreams()[0];
        if (localStream.getAudioTracks().length > 0) {
            const track = localStream.getAudioTracks()[0];
            if(this.state.audioMuted) {
                DEBUG('Unmute microphone');
                track.enabled = true;
                this.setState({audioMuted: false});
            } else {
                DEBUG('Mute microphone');
                track.enabled = false;
                this.setState({audioMuted: true});
            }
        }
    }

    muteVideo(event) {
        event.preventDefault();
        const localStream = this.props.call.getLocalStreams()[0];
        if (localStream.getVideoTracks().length > 0) {
            const track = localStream.getVideoTracks()[0];
            if (this.state.videoMuted) {
                DEBUG('Unmute camera');
                track.enabled = true;
                this.setState({videoMuted: false});
            } else {
                DEBUG('Mute camera');
                track.enabled = false;
                this.setState({videoMuted: true});
            }
        }
    }

    hangup(event) {
        event.preventDefault();
        for (let participant of this.state.participants) {
            participant.detach();
        }
        this.props.hangup();
    }

    startCallTimer() {
        const startTime = new Date();
        this.callTimer = setInterval(() => {
            this.callDuration = moment.duration(new Date() - startTime).format('hh:mm:ss', {trim: false});
            if (this.state.callOverlayVisible) {
                this.forceUpdate();
            }
        }, 300);
    }

    armOverlayTimer() {
        clearTimeout(this.overlayTimer);
        this.overlayTimer = setTimeout(() => {
            this.setState({callOverlayVisible: false});
        }, 4000);
    }

    showOverlay() {
        if (!this.state.shareOverlayVisible) {
            this.setState({callOverlayVisible: true});
            this.armOverlayTimer();
        }
    }

    toggleInviteModal() {
        this.setState({showInviteModal: !this.state.showInviteModal});
        if (this.refs.showOverlay) {
            this.refs.shareOverlay.hide();
        }
    }

    render() {
        if (this.props.call === null) {
            return (<div></div>);
        }

        let videoHeader;
        let callButtons;
        let watermark;

        const largeVideoClasses = classNames({
            'animated'      : true,
            'fadeIn'        : true,
            'large'         : true,
            'mirror'        : this.state.currentLargeVideo.isLocal && this.state.currentLargeVideo.hasVideo,
            'poster'        : !this.state.currentLargeVideo.hasVideo
        });

        if (this.state.callOverlayVisible) {
            const muteButtonIcons = classNames({
                'fa'                    : true,
                'fa-microphone'         : !this.state.audioMuted,
                'fa-microphone-slash'   : this.state.audioMuted
            });

            const muteVideoButtonIcons = classNames({
                'fa'                    : true,
                'fa-video-camera'       : !this.state.videoMuted,
                'fa-video-camera-slash' : this.state.videoMuted
            });

            const fullScreenButtonIcons = classNames({
                'fa'            : true,
                'fa-expand'     : !this.isFullScreen(),
                'fa-compress'   : this.isFullScreen()
            });

            const videoHeaderTextClasses = classNames({
                'lead'          : true
            });

            const commonButtonClasses = classNames({
                'btn'           : true,
                'btn-round'     : true,
                'btn-default'   : true
            });

            const rotateButtonClasses = classNames({
                'btn'           : true,
                'btn-round'     : true,
                'btn-default'   : !this.state.autoRotate,
                'btn-primary'   : this.state.autoRotate
            });

            const remoteIdentity = this.props.remoteIdentity.split('@')[0];

            let callDetail;
            if (this.state.callDetail !== null) {
                const participantCount = this.state.participants.length + 1;
                callDetail = (
                    <span>
                        <i className="fa fa-clock-o"></i> {this.callDuration}
                        &nbsp;&mdash;&nbsp;
                        <i className="fa fa-users"></i> {participantCount} participant{participantCount > 1 ? 's' : ''}
                    </span>
                );
            } else {
                callDetail = 'Connecting...'
            }

            videoHeader = (
                    <div key="header" className="call-header">
                        <p className={videoHeaderTextClasses}><strong>Conference:</strong> {remoteIdentity}</p>
                        <p className={videoHeaderTextClasses}>{callDetail}</p>
                    </div>
            );

            const shareOverlay = (
                <Popover id="shareOverlay" title="Join me, maybe?">
                    <p>
                        Invite other online users of this service, share <strong><a href={this.callUrl} target="_blank" rel="noopener noreferrer">this link</a></strong> with others or email, so they can easily join this conference.
                    </p>
                    <div className="text-center">
                        <div className="btn-group">
                            <button className="btn btn-primary" onClick={this.toggleInviteModal} alt="Invite users">
                                <i className="fa fa-user-plus"></i>
                            </button>
                            <button className="btn btn-primary" onClick={this.handleClipboardButton} alt="Copy to clipboard">
                                <i className="fa fa-clipboard"></i>
                            </button>
                            <a className="btn btn-primary" href={this.emailLink} alt="Send email">
                                <i className="fa fa-envelope-o"></i>
                            </a>
                        </div>
                    </div>
                </Popover>
            );

            const buttons = [];

            buttons.push(<button key="muteVideo" type="button" title="Mute/unmute video" className={commonButtonClasses} onClick={this.muteVideo}> <i className={muteVideoButtonIcons}></i> </button>);
            buttons.push(<button key="muteAudio" type="button" title="Mute/unmute audio" className={commonButtonClasses} onClick={this.muteAudio}> <i className={muteButtonIcons}></i> </button>);
            buttons.push(<OverlayTrigger key="shareOverlay" ref="shareOverlay" trigger="click" placement="bottom" overlay={shareOverlay} onEntered={this.handleShareOverlayEntered} onExited={this.handleShareOverlayExited} rootClose>
                            <button key="shareButton" type="button" title="Share link to this conference" className={commonButtonClasses}> <i className="fa fa-plus"></i> </button>
                         </OverlayTrigger>);
            if (this.isFullscreenSupported()) {
                buttons.push(<button key="fsButton" type="button" title="Go full-screen" className={commonButtonClasses} onClick={this.handleFullscreen}> <i className={fullScreenButtonIcons}></i> </button>);
            }
            if (this.state.participants.length > 0) {
                buttons.push(<button key="autoRotate" type="button" title="Automatically switch to active speaker" className={rotateButtonClasses} onClick={this.toggleAutoRotate}> <i className="fa fa-street-view"></i> </button>);
            }
            buttons.push(<button key="hangupButton" type="button" title="Leave conference" className="btn btn-round btn-danger" onClick={this.hangup}> <i className="fa fa-phone rotate-135"></i> </button>);

            callButtons = (
                <div className="conference-buttons">
                    {buttons}
                </div>
            );
        } else {
            watermark = <div className="watermark"></div>;
        }

        const participants = [];

        if (this.state.participants.length > 0) {
            participants.push(<ConferenceParticipantSelf
                                    key="myself"
                                    stream={this.props.call.getLocalStreams()[0]}
                                    identity={this.props.call.localIdentity}
                                    selected={this.onVideoSelected}
                                    active={this.onParticipantActive}
                                    audioMuted={this.state.audioMuted}
                              />
            );
        }

        this.state.participants.forEach((p) => {
            participants.push(<ConferenceParticipant
                                    key={p.id}
                                    participant={p}
                                    selected={this.onVideoSelected}
                                    active={this.onParticipantActive}
                              />
            );
        });

        return (
            <div className="video-container conference" onMouseMove={this.showOverlay}>
                <div className="top-overlay">
                    <CSSTransitionGroup transitionName="videoheader" transitionEnterTimeout={300} transitionLeaveTimeout={300}>
                        {videoHeader}
                        {callButtons}
                    </CSSTransitionGroup>
                </div>
                <CSSTransitionGroup transitionName="watermark" transitionEnterTimeout={600} transitionLeaveTimeout={300}>
                    {watermark}
                </CSSTransitionGroup>
                <video ref="largeVideo" className={largeVideoClasses} poster="assets/images/transparent-1px.png" autoPlay muted />
                <div className="conference-thumbnails" onMouseMove={this.preventOverlay}>
                    <ConferenceCarousel>
                        {participants}
                    </ConferenceCarousel>
                </div>
                <AudioPlayer ref="audioPlayerParticipantJoined" sourceFile="assets/sounds/participant_joined.wav" />
                <AudioPlayer ref="audioPlayerParticipantLeft" sourceFile="assets/sounds/participant_left.wav" />
                <InviteParticipantsModal
                    show={this.state.showInviteModal}
                    call={this.props.call}
                    close={this.toggleInviteModal}
                />
            </div>
        );
    }
}

ConferenceBox.propTypes = {
    notificationCenter : PropTypes.func.isRequired,
    call               : PropTypes.object,
    hangup             : PropTypes.func,
    remoteIdentity     : PropTypes.string
};

ReactMixin(ConferenceBox.prototype, FullscreenMixin);


module.exports = ConferenceBox;
