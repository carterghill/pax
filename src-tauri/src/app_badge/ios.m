#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>
#import <objc/runtime.h>
#include <stdint.h>

extern void pax_ios_badge_token(const char *token);

static NSInteger badgeCount;
static BOOL badgeAuthorizationRequested;

static void applyBadgeCount(void) {
    if (@available(iOS 16.0, *)) {
        [UNUserNotificationCenter.currentNotificationCenter setBadgeCount:badgeCount
                                                   withCompletionHandler:nil];
    } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        UIApplication.sharedApplication.applicationIconBadgeNumber = badgeCount;
#pragma clang diagnostic pop
    }
}

static void requestBadgeAuthorization(void) {
    if (badgeAuthorizationRequested) return;
    badgeAuthorizationRequested = YES;
    [UNUserNotificationCenter.currentNotificationCenter
        requestAuthorizationWithOptions:UNAuthorizationOptionBadge | UNAuthorizationOptionAlert | UNAuthorizationOptionSound
                       completionHandler:^(BOOL granted, NSError *error) {
        if (error) NSLog(@"Pax could not request badge authorization: %@", error);
        if (granted) dispatch_async(dispatch_get_main_queue(), ^{ applyBadgeCount(); });
    }];
}

void pax_ios_set_badge_count(int32_t count) {
    dispatch_async(dispatch_get_main_queue(), ^{
        badgeCount = count;
        if (count > 0) requestBadgeAuthorization();
        applyBadgeCount();
    });
}

static void didRegister(__unused id delegate, __unused SEL selector,
                        __unused UIApplication *application, NSData *token) {
    const unsigned char *bytes = token.bytes;
    NSMutableString *hex = [NSMutableString stringWithCapacity:token.length * 2];
    for (NSUInteger i = 0; i < token.length; i++) {
        [hex appendFormat:@"%02x", (unsigned int)bytes[i]];
    }
    pax_ios_badge_token(hex.UTF8String);
}

static void didFailToRegister(__unused id delegate, __unused SEL selector,
                              __unused UIApplication *application, NSError *error) {
    NSLog(@"Pax could not register for APNs badges: %@", error);
}

void pax_ios_enable_badge_push(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        UIApplication *app = UIApplication.sharedApplication;
        // Tao owns the application delegate. Install its two APNs callbacks
        // before asking UIKit to register this device.
        Class delegateClass = object_getClass(app.delegate);
        if (!delegateClass ||
            !class_addMethod(delegateClass, @selector(application:didRegisterForRemoteNotificationsWithDeviceToken:),
                             (IMP)didRegister, "v@:@@")) {
            NSLog(@"Pax could not install the APNs badge token callback");
            return;
        }
        class_addMethod(delegateClass, @selector(application:didFailToRegisterForRemoteNotificationsWithError:),
                        (IMP)didFailToRegister, "v@:@@");
        requestBadgeAuthorization();
        [app registerForRemoteNotifications];
    });
}
