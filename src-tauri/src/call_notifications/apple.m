#import <Foundation/Foundation.h>
#import <TargetConditionals.h>
#include <stdbool.h>
#include <stdint.h>

extern void pax_apple_call_action(const char *id, uint32_t action);

#if TARGET_OS_IOS
#import <CallKit/CallKit.h>
#import <PushKit/PushKit.h>

extern void pax_ios_voip_token(const char *token);

@interface PaxCallProvider : NSObject <CXProviderDelegate, PKPushRegistryDelegate>
@property(nonatomic, strong) CXProvider *provider;
@property(nonatomic, strong) CXCallController *controller;
@property(nonatomic, strong) NSUUID *callID;
@property(nonatomic, strong) NSUUID *lastEndedCall;
@property(nonatomic, strong) CXAnswerCallAction *answer;
@property(nonatomic) BOOL answering;
@property(nonatomic) BOOL connected;
@property(nonatomic) BOOL busy;
@property(nonatomic, strong) PKPushRegistry *pushRegistry;
@end

@implementation PaxCallProvider
- (instancetype)init {
    if (!(self = [super init])) return nil;
    CXProviderConfiguration *configuration;
    if (@available(iOS 14.0, *)) {
        configuration = [[CXProviderConfiguration alloc] init];
    } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        configuration = [[CXProviderConfiguration alloc] initWithLocalizedName:@"Pax"];
#pragma clang diagnostic pop
    }
    configuration.maximumCallGroups = 1;
    configuration.maximumCallsPerCallGroup = 1;
    configuration.includesCallsInRecents = NO;
    configuration.supportedHandleTypes = [NSSet setWithObject:@(CXHandleTypeGeneric)];
    _provider = [[CXProvider alloc] initWithConfiguration:configuration];
    [_provider setDelegate:self queue:dispatch_get_main_queue()];
    _controller = [[CXCallController alloc] init];
    return self;
}

- (void)present:(NSUUID *)callID caller:(NSString *)name remaining:(uint64_t)remaining
     fromPush:(BOOL)fromPush completion:(void (^)(void))completion {
    BOOL duplicate = [self.callID isEqual:callID];
    if (duplicate && !fromPush) {
        completion();
        return;
    }
    BOOL discard = !duplicate && (remaining == 0 || (fromPush && (self.callID || self.busy)) || [self.lastEndedCall isEqual:callID]);
    if (discard && !fromPush) {
        completion();
        return;
    }
    if (!duplicate && !discard) {
        if (self.callID) [self end:self.callID reason:CXCallEndedReasonRemoteEnded];
        self.callID = callID;
    }
    CXCallUpdate *update = [[CXCallUpdate alloc] init];
    update.remoteHandle = [[CXHandle alloc] initWithType:CXHandleTypeGeneric value:name];
    update.localizedCallerName = name;
    [self.provider reportNewIncomingCallWithUUID:callID update:update completion:^(NSError *error) {
        if (error && !duplicate) NSLog(@"Pax could not report an incoming call: %@", error);
        if (!error && discard) [self.provider reportCallWithUUID:callID endedAtDate:nil reason:CXCallEndedReasonUnanswered];
        completion();
    }];
    if (!duplicate && !discard) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)remaining * NSEC_PER_MSEC),
                       dispatch_get_main_queue(), ^{
            if (!self.answering) [self end:callID reason:CXCallEndedReasonUnanswered];
        });
    }
}

- (void)end:(NSUUID *)callID reason:(CXCallEndedReason)reason {
    if (![self.callID isEqual:callID]) return;
    [self.answer fail];
    self.lastEndedCall = callID;
    self.answer = nil;
    self.callID = nil;
    self.answering = NO;
    self.connected = NO;
    [self.provider reportCallWithUUID:callID endedAtDate:nil reason:reason];
}

- (void)providerDidReset:(CXProvider *)provider {
    NSUUID *callID = self.callID;
    if (!callID) return;
    [self end:callID reason:CXCallEndedReasonFailed];
    pax_apple_call_action(callID.UUIDString.UTF8String, 4);
}

- (void)provider:(CXProvider *)provider performAnswerCallAction:(CXAnswerCallAction *)action {
    if (![self.callID isEqual:action.callUUID]) {
        [action fail];
        return;
    }
    self.answering = YES;
    if (self.connected) {
        [action fulfill];
    } else {
        self.answer = action;
        pax_apple_call_action(action.callUUID.UUIDString.UTF8String, 1);
    }
}

- (void)provider:(CXProvider *)provider performEndCallAction:(CXEndCallAction *)action {
    if ([self.callID isEqual:action.callUUID]) {
        BOOL incoming = !self.answering && !self.connected;
        self.lastEndedCall = action.callUUID;
        [self.answer fail];
        self.answer = nil;
        self.callID = nil;
        self.answering = NO;
        self.connected = NO;
        pax_apple_call_action(action.callUUID.UUIDString.UTF8String, incoming ? 2 : 4);
    }
    [action fulfill];
}

- (void)provider:(CXProvider *)provider timedOutPerformingAction:(CXCallAction *)action {
    if (![self.callID isEqual:action.callUUID]) return;
    [self end:action.callUUID reason:CXCallEndedReasonFailed];
    pax_apple_call_action(action.callUUID.UUIDString.UTF8String, 4);
}

- (void)pushRegistry:(PKPushRegistry *)registry didUpdatePushCredentials:(PKPushCredentials *)credentials
             forType:(PKPushType)type {
    if (![type isEqualToString:PKPushTypeVoIP]) return;
    const unsigned char *bytes = credentials.token.bytes;
    NSMutableString *token = [NSMutableString stringWithCapacity:credentials.token.length * 2];
    for (NSUInteger index = 0; index < credentials.token.length; index++) {
        [token appendFormat:@"%02x", bytes[index]];
    }
    pax_ios_voip_token(token.UTF8String);
}

- (void)pushRegistry:(PKPushRegistry *)registry didInvalidatePushTokenForType:(PKPushType)type {
    if ([type isEqualToString:PKPushTypeVoIP]) pax_ios_voip_token(NULL);
}

- (void)pushRegistry:(PKPushRegistry *)registry didReceiveIncomingPushWithPayload:(PKPushPayload *)payload
             forType:(PKPushType)type withCompletionHandler:(void (^)(void))completion {
    if (![type isEqualToString:PKPushTypeVoIP]) {
        completion();
        return;
    }
    NSDictionary *data = payload.dictionaryPayload;
    NSString *idString = [data[@"callId"] isKindOfClass:NSString.class] ? data[@"callId"] : nil;
    NSUUID *callID = idString ? [[NSUUID alloc] initWithUUIDString:idString] : nil;
    NSString *name = [data[@"caller"] isKindOfClass:NSString.class] ? data[@"caller"] : @"Pax contact";
    NSNumber *deadline = [data[@"expiresAt"] isKindOfClass:NSNumber.class] ? data[@"expiresAt"] : nil;
    double remaining = deadline.doubleValue - NSDate.date.timeIntervalSince1970 * 1000.0;
    // An old registration may still have a push in flight during an app upgrade.
    // Only the policy-aware gateway can produce an actionable incoming call.
    if (![data[@"callPolicyVersion"] isEqual:@1]) {
        name = @"Pax";
        remaining = 0;
    }
    // PushKit requires each delivered VoIP push to be reported, even if it arrived late.
    [self present:callID ?: NSUUID.UUID caller:name remaining:callID ? (uint64_t)MIN(150000.0, MAX(0.0, remaining)) : 0
          fromPush:YES completion:completion];
}
@end

static PaxCallProvider *calls;

void pax_ios_set_busy(bool busy) {
    dispatch_async(dispatch_get_main_queue(), ^{ calls.busy = busy; });
}

void pax_ios_voip_enable(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!calls) calls = [[PaxCallProvider alloc] init];
        if (calls.pushRegistry) return;
        calls.pushRegistry = [[PKPushRegistry alloc] initWithQueue:dispatch_get_main_queue()];
        calls.pushRegistry.delegate = calls;
        calls.pushRegistry.desiredPushTypes = [NSSet setWithObject:PKPushTypeVoIP];
    });
}

void pax_apple_call_show(const char *id, const char *caller, uint64_t remaining) {
    NSUUID *callID = [[NSUUID alloc] initWithUUIDString:@(id)];
    NSString *name = @(caller);
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!calls) calls = [[PaxCallProvider alloc] init];
        [calls present:callID caller:name remaining:remaining fromPush:NO completion:^{}];
    });
}

void pax_apple_call_update(const char *id, bool active) {
    NSUUID *callID = [[NSUUID alloc] initWithUUIDString:@(id)];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (![calls.callID isEqual:callID]) return;
        calls.connected = active;
        if (!calls.answering) {
            calls.answering = YES;
            CXAnswerCallAction *answer = [[CXAnswerCallAction alloc] initWithCallUUID:callID];
            CXTransaction *transaction = [[CXTransaction alloc] initWithAction:answer];
            [calls.controller requestTransaction:transaction completion:^(NSError *error) {
                if (error) NSLog(@"Pax could not update the system call: %@", error);
            }];
        }
        if (active) {
            [calls.answer fulfill];
            calls.answer = nil;
        }
    });
}

void pax_apple_call_close(const char *id) {
    NSUUID *callID = [[NSUUID alloc] initWithUUIDString:@(id)];
    dispatch_async(dispatch_get_main_queue(), ^{
        [calls end:callID reason:CXCallEndedReasonRemoteEnded];
    });
}

void pax_ios_close_ringing_call(const char *id) {
    NSUUID *callID = [[NSUUID alloc] initWithUUIDString:@(id)];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (calls && !calls.callID) calls.lastEndedCall = callID;
        if (!calls.answering) [calls end:callID reason:CXCallEndedReasonRemoteEnded];
    });
}

#else
#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>

static NSString * const PaxCallCategory = @"pax.incoming-call";

// A bare development executable cannot register with Notification Center.
@interface PaxDevelopmentCallAlert : NSObject
@property(nonatomic, strong) NSPanel *panel;
@property(nonatomic, copy) NSString *callID;
- (instancetype)initWithCallID:(NSString *)callID caller:(NSString *)name;
@end

@implementation PaxDevelopmentCallAlert
- (instancetype)initWithCallID:(NSString *)callID caller:(NSString *)name {
    if (!(self = [super init])) return nil;
    self.callID = callID;

    NSRect frame = NSMakeRect(0, 0, 320, 113);
    self.panel = [[NSPanel alloc] initWithContentRect:frame
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskFullSizeContentView | NSWindowStyleMaskNonactivatingPanel
        backing:NSBackingStoreBuffered defer:NO];
    self.panel.title = @"Pax incoming call";
    self.panel.titleVisibility = NSWindowTitleHidden;
    self.panel.titlebarAppearsTransparent = YES;
    self.panel.floatingPanel = YES;
    self.panel.hidesOnDeactivate = NO;
    self.panel.becomesKeyOnlyIfNeeded = YES;
    self.panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
        NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorIgnoresCycle;

    NSTextField *title = [NSTextField labelWithString:@"Incoming call"];
    title.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
    NSTextField *caller = [NSTextField labelWithString:name.length ? name : @"Pax contact"];
    caller.lineBreakMode = NSLineBreakByTruncatingTail;
    NSButton *answer = [NSButton buttonWithTitle:@"Answer" target:self action:@selector(selectAction:)];
    answer.tag = 1;
    NSButton *decline = [NSButton buttonWithTitle:@"Decline" target:self action:@selector(selectAction:)];
    decline.tag = 2;

    NSStackView *buttons = [NSStackView stackViewWithViews:@[decline, answer]];
    buttons.spacing = 8;
    NSStackView *rows = [NSStackView stackViewWithViews:@[title, caller, buttons]];
    rows.orientation = NSUserInterfaceLayoutOrientationVertical;
    rows.alignment = NSLayoutAttributeLeading;
    rows.spacing = 8;
    rows.translatesAutoresizingMaskIntoConstraints = NO;
    NSView *content = self.panel.contentView;
    [content addSubview:rows];
    [NSLayoutConstraint activateConstraints:@[
        [rows.leadingAnchor constraintEqualToAnchor:content.leadingAnchor constant:16],
        [rows.trailingAnchor constraintEqualToAnchor:content.trailingAnchor constant:-16],
        [rows.centerYAnchor constraintEqualToAnchor:content.centerYAnchor],
        [caller.widthAnchor constraintLessThanOrEqualToAnchor:rows.widthAnchor],
    ]];

    NSScreen *screen = NSApp.mainWindow.screen ?: NSScreen.mainScreen;
    if (screen) {
        NSRect visible = screen.visibleFrame;
        [self.panel setFrameTopLeftPoint:NSMakePoint(NSMaxX(visible) - NSWidth(frame) - 16, NSMaxY(visible) - 16)];
    }
    return self;
}

- (void)selectAction:(NSButton *)button {
    [self.panel orderOut:nil];
    pax_apple_call_action(self.callID.UTF8String, (uint32_t)button.tag);
}
@end

API_AVAILABLE(macos(10.14))
@interface PaxCallNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@property(nonatomic, weak) id<UNUserNotificationCenterDelegate> previous;
@end

@implementation PaxCallNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
    if ([notification.request.content.categoryIdentifier isEqualToString:PaxCallCategory]) {
        if (@available(macOS 11.0, *)) completion(UNNotificationPresentationOptionBanner);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        else completion(UNNotificationPresentationOptionAlert);
#pragma clang diagnostic pop
    } else if ([self.previous respondsToSelector:_cmd]) {
        [self.previous userNotificationCenter:center willPresentNotification:notification withCompletionHandler:completion];
    } else {
        completion(UNNotificationPresentationOptionNone);
    }
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completion {
    UNNotificationRequest *request = response.notification.request;
    if (![request.content.categoryIdentifier isEqualToString:PaxCallCategory] && [self.previous respondsToSelector:_cmd]) {
        [self.previous userNotificationCenter:center didReceiveNotificationResponse:response withCompletionHandler:completion];
        return;
    }
    if ([request.content.categoryIdentifier isEqualToString:PaxCallCategory]) {
        uint32_t action = 0;
        if ([response.actionIdentifier isEqualToString:@"answer"]) action = 1;
        if ([response.actionIdentifier isEqualToString:@"decline"]) action = 2;
        if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) action = 3;
        if (action) pax_apple_call_action(request.identifier.UTF8String, action);
    }
    completion();
}
@end

static PaxDevelopmentCallAlert *developmentAlert;
static NSString *pendingCall;

static BOOL PaxUsesNotificationCenter(void) {
    return [NSBundle.mainBundle.bundleURL.pathExtension.lowercaseString isEqualToString:@"app"];
}

static UNUserNotificationCenter *PaxCallNotificationCenter(void) API_AVAILABLE(macos(10.14)) {
    static PaxCallNotificationDelegate *notificationDelegate;
    UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
    if (!notificationDelegate) notificationDelegate = [[PaxCallNotificationDelegate alloc] init];
    if (center.delegate != notificationDelegate) {
        notificationDelegate.previous = center.delegate;
        center.delegate = notificationDelegate;
    }
    return center;
}

static void PaxCloseMacCall(NSString *callID) {
    if (![pendingCall isEqualToString:callID]) return;
    pendingCall = nil;
    if (developmentAlert) {
        [developmentAlert.panel orderOut:nil];
        developmentAlert = nil;
        return;
    }
    if (@available(macOS 10.14, *)) {
        UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
        [center removePendingNotificationRequestsWithIdentifiers:@[callID]];
        [center removeDeliveredNotificationsWithIdentifiers:@[callID]];
    }
}

void pax_macos_call_enable(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (@available(macOS 10.14, *)) {
            if (!PaxUsesNotificationCenter()) return;
            [PaxCallNotificationCenter() requestAuthorizationWithOptions:UNAuthorizationOptionAlert completionHandler:^(BOOL granted, NSError *error) {
                if (error) NSLog(@"Pax could not request notification authorization: %@", error);
                else if (!granted) NSLog(@"Pax call banners are disabled in macOS notification settings.");
            }];
        }
    });
}

static void PaxPostMacCall(NSString *callID, NSString *name) API_AVAILABLE(macos(10.14)) {
    UNUserNotificationCenter *center = PaxCallNotificationCenter();
    UNNotificationAction *answer = [UNNotificationAction actionWithIdentifier:@"answer" title:@"Answer" options:UNNotificationActionOptionForeground];
    UNNotificationAction *decline = [UNNotificationAction actionWithIdentifier:@"decline" title:@"Decline" options:UNNotificationActionOptionDestructive];
    UNNotificationCategory *category = [UNNotificationCategory categoryWithIdentifier:PaxCallCategory actions:@[answer, decline] intentIdentifiers:@[] options:0];
    [center getNotificationCategoriesWithCompletionHandler:^(NSSet<UNNotificationCategory *> *categories) {
        [center setNotificationCategories:[categories setByAddingObject:category]];
        [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert completionHandler:^(BOOL granted, NSError *error) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (error) NSLog(@"Pax could not request notification authorization: %@", error);
                if (!granted || ![pendingCall isEqualToString:callID]) return;
                UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
                content.title = @"Incoming call";
                content.body = name;
                content.categoryIdentifier = PaxCallCategory;
                UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:callID content:content trigger:nil];
                [center addNotificationRequest:request withCompletionHandler:^(NSError *postError) {
                    dispatch_async(dispatch_get_main_queue(), ^{
                        if (![pendingCall isEqualToString:callID]) [UNUserNotificationCenter.currentNotificationCenter removeDeliveredNotificationsWithIdentifiers:@[callID]];
                        if (postError) NSLog(@"Pax could not post an incoming call: %@", postError);
                    });
                }];
            });
        }];
    }];
}

void pax_apple_call_show(const char *id, const char *caller, uint64_t remaining) {
    NSString *callID = @(id);
    NSString *name = @(caller);
    dispatch_async(dispatch_get_main_queue(), ^{
        PaxCloseMacCall(pendingCall);
        pendingCall = callID;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)remaining * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            PaxCloseMacCall(callID);
        });
        if (@available(macOS 10.14, *)) {
            if (PaxUsesNotificationCenter()) {
                PaxPostMacCall(callID, name);
                return;
            }
        }
        developmentAlert = [[PaxDevelopmentCallAlert alloc] initWithCallID:callID caller:name];
        [developmentAlert.panel orderFrontRegardless];
    });
}

void pax_apple_call_close(const char *id) {
    NSString *callID = @(id);
    dispatch_async(dispatch_get_main_queue(), ^{
        PaxCloseMacCall(callID);
    });
}
#endif
