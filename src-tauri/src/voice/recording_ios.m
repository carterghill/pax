#import <AVFoundation/AVFoundation.h>

@interface PaxRecordingSession : NSObject
@property(nonatomic, copy) AVAudioSessionCategory previousCategory;
@property(nonatomic, copy) AVAudioSessionMode previousMode;
@property(nonatomic) AVAudioSessionCategoryOptions previousOptions;
@end

@implementation PaxRecordingSession
@end

static const AVAudioSessionCategoryOptions RecordingOptions =
    AVAudioSessionCategoryOptionDefaultToSpeaker;

void *pax_begin_recording_audio_session(void) {
    @autoreleasepool {
        AVAudioSession *session = AVAudioSession.sharedInstance;
        dispatch_semaphore_t permission = dispatch_semaphore_create(0);
        __block BOOL granted = NO;
        void (^result)(BOOL) = ^(BOOL allowed) {
            granted = allowed;
            dispatch_semaphore_signal(permission);
        };
        if (@available(iOS 17.0, *)) {
            [AVAudioApplication requestRecordPermissionWithCompletionHandler:result];
        } else {
            [session requestRecordPermission:result];
        }
        if (dispatch_semaphore_wait(permission, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC)) || !granted) {
            return NULL;
        }

        PaxRecordingSession *token = [PaxRecordingSession new];
        if ([session.category isEqualToString:AVAudioSessionCategoryPlayAndRecord]) {
            return (__bridge_retained void *)token;
        }

        token.previousCategory = session.category;
        token.previousMode = session.mode;
        token.previousOptions = session.categoryOptions;
        if (![session setCategory:AVAudioSessionCategoryPlayAndRecord mode:AVAudioSessionModeDefault options:RecordingOptions error:NULL]) {
            return NULL;
        }
        if (![session setActive:YES error:NULL]) {
            [session setCategory:token.previousCategory mode:token.previousMode options:token.previousOptions error:NULL];
            return NULL;
        }
        return (__bridge_retained void *)token;
    }
}

void pax_end_recording_audio_session(void *handle) {
    @autoreleasepool {
        PaxRecordingSession *token = (__bridge_transfer PaxRecordingSession *)handle;
        AVAudioSession *session = AVAudioSession.sharedInstance;
        if (token.previousCategory && [session.category isEqualToString:AVAudioSessionCategoryPlayAndRecord]
            && [session.mode isEqualToString:AVAudioSessionModeDefault] && session.categoryOptions == RecordingOptions) {
            [session setCategory:token.previousCategory mode:token.previousMode options:token.previousOptions error:NULL];
        }
    }
}
