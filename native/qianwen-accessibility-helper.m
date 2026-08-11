#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <Vision/Vision.h>

static NSString *const QianwenBundleIdentifier = @"com.alibaba.tongyi";
static NSString *const QianwenApplicationPath = @"/Applications/Qianwen.app";
static const NSUInteger MaximumNodeCount = 12000;
static const NSUInteger MaximumDepth = 80;

static BOOL ElementFrame(AXUIElementRef element, CGRect *frame);

static NSString *StringAttribute(AXUIElementRef element, CFStringRef attribute) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess || value == NULL) {
    return nil;
  }
  NSString *result = nil;
  if (CFGetTypeID(value) == CFStringGetTypeID()) {
    result = [(__bridge NSString *)value copy];
  } else if (CFGetTypeID(value) == CFURLGetTypeID()) {
    result = [(__bridge NSURL *)value absoluteString];
  } else if (CFGetTypeID(value) == CFNumberGetTypeID()) {
    result = [(__bridge NSNumber *)value stringValue];
  }
  CFRelease(value);
  return result;
}

static NSArray<NSString *> *Actions(AXUIElementRef element) {
  CFArrayRef names = NULL;
  if (AXUIElementCopyActionNames(element, &names) != kAXErrorSuccess || names == NULL) {
    return @[];
  }
  NSArray<NSString *> *result = [(__bridge NSArray<NSString *> *)names copy];
  CFRelease(names);
  return result;
}

static NSNumber *BooleanAttribute(AXUIElementRef element, CFStringRef attribute) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess || value == NULL) {
    return nil;
  }
  NSNumber *result = nil;
  if (CFGetTypeID(value) == CFBooleanGetTypeID()) {
    result = @([(__bridge NSNumber *)value boolValue]);
  } else if (CFGetTypeID(value) == CFNumberGetTypeID()) {
    result = @([(__bridge NSNumber *)value boolValue]);
  }
  CFRelease(value);
  return result;
}

static AXUIElementRef CopyParent(AXUIElementRef element) {
  CFTypeRef parent = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXParentAttribute, &parent) != kAXErrorSuccess
      || parent == NULL
      || CFGetTypeID(parent) != AXUIElementGetTypeID()) {
    if (parent != NULL) CFRelease(parent);
    return NULL;
  }
  return (AXUIElementRef)parent;
}

static AXUIElementRef CopyNearestPressable(AXUIElementRef element) {
  AXUIElementRef current = (AXUIElementRef)CFRetain(element);
  for (NSUInteger depth = 0; depth < 12 && current != NULL; depth += 1) {
    if ([Actions(current) containsObject:(__bridge NSString *)kAXPressAction]) {
      return current;
    }
    AXUIElementRef parent = CopyParent(current);
    CFRelease(current);
    current = parent;
  }
  if (current != NULL) CFRelease(current);
  return NULL;
}

static BOOL ElementOrAncestorEquals(AXUIElementRef element, AXUIElementRef target) {
  AXUIElementRef current = (AXUIElementRef)CFRetain(element);
  for (NSUInteger depth = 0; depth < 16 && current != NULL; depth += 1) {
    if (CFEqual(current, target)) {
      CFRelease(current);
      return YES;
    }
    AXUIElementRef parent = CopyParent(current);
    CFRelease(current);
    current = parent;
  }
  if (current != NULL) CFRelease(current);
  return NO;
}

static BOOL ElementIsHittable(
  AXUIElementRef systemWide,
  AXUIElementRef element,
  CGRect frame
) {
  AXUIElementRef hit = NULL;
  CGPoint point = CGPointMake(CGRectGetMidX(frame), CGRectGetMidY(frame));
  if (AXUIElementCopyElementAtPosition(systemWide, point.x, point.y, &hit) != kAXErrorSuccess
      || hit == NULL) {
    if (hit != NULL) CFRelease(hit);
    return NO;
  }
  BOOL result = ElementOrAncestorEquals(hit, element)
    || ElementOrAncestorEquals(element, hit);
  CFRelease(hit);
  return result;
}

static NSArray *Children(AXUIElementRef element) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &value) != kAXErrorSuccess
      || value == NULL
      || CFGetTypeID(value) != CFArrayGetTypeID()) {
    if (value != NULL) CFRelease(value);
    return @[];
  }
  NSArray *children = [(__bridge NSArray *)value copy];
  CFRelease(value);
  return children;
}

static void AppendNode(
  AXUIElementRef systemWide,
  AXUIElementRef element,
  NSUInteger depth,
  NSMutableArray<NSDictionary *> *nodes
) {
  if (nodes.count >= MaximumNodeCount || depth > MaximumDepth) return;
  NSString *role = StringAttribute(element, kAXRoleAttribute) ?: @"";
  NSString *title = StringAttribute(element, kAXTitleAttribute);
  NSString *value = StringAttribute(element, kAXValueAttribute);
  NSString *description = StringAttribute(element, kAXDescriptionAttribute);
  NSString *identifier = StringAttribute(element, kAXIdentifierAttribute);
  NSString *url = StringAttribute(element, kAXURLAttribute);
  NSNumber *selected = BooleanAttribute(element, kAXSelectedAttribute);
  CGRect frame = CGRectZero;
  BOOL hasFrame = ElementFrame(element, &frame);
  NSArray<NSString *> *actions = Actions(element);

  NSString *visibleText = title.length > 0
    ? title
    : (value.length > 0 ? value : description);
  if (visibleText.length > 0 && ![actions containsObject:(__bridge NSString *)kAXPressAction]) {
    AXUIElementRef pressable = CopyNearestPressable(element);
    if (pressable != NULL) {
      actions = [actions arrayByAddingObject:(__bridge NSString *)kAXPressAction];
      if (identifier.length == 0) identifier = StringAttribute(pressable, kAXIdentifierAttribute);
      CFRelease(pressable);
    }
  }

  NSMutableDictionary *node = [@{
    @"depth": @(depth),
    @"role": role,
    @"actions": actions,
  } mutableCopy];
  if (title.length > 0) node[@"title"] = title;
  if (value.length > 0) node[@"value"] = value;
  if (description.length > 0) node[@"description"] = description;
  if (identifier.length > 0) node[@"identifier"] = identifier;
  if (url.length > 0) node[@"url"] = url;
  if (selected != nil) node[@"selected"] = selected;
  if (hasFrame) {
    node[@"frame"] = @{
      @"x": @(frame.origin.x),
      @"y": @(frame.origin.y),
      @"width": @(frame.size.width),
      @"height": @(frame.size.height),
    };
    if (visibleText.length > 0) node[@"hittable"] = @(ElementIsHittable(systemWide, element, frame));
  }
  [nodes addObject:node];

  for (id child in Children(element)) {
    if (CFGetTypeID((__bridge CFTypeRef)child) != AXUIElementGetTypeID()) continue;
    AppendNode(systemWide, (__bridge AXUIElementRef)child, depth + 1, nodes);
    if (nodes.count >= MaximumNodeCount) break;
  }
}

static NSArray *Windows(AXUIElementRef application) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &value) != kAXErrorSuccess
      || value == NULL
      || CFGetTypeID(value) != CFArrayGetTypeID()) {
    if (value != NULL) CFRelease(value);
    return @[];
  }
  NSArray *windows = [(__bridge NSArray *)value copy];
  CFRelease(value);
  return windows;
}

static NSMutableArray<NSDictionary *> *NodesForApplication(NSRunningApplication *application) {
  AXUIElementRef systemWide = AXUIElementCreateSystemWide();
  AXUIElementRef element = AXUIElementCreateApplication(application.processIdentifier);
  NSMutableArray<NSDictionary *> *nodes = [NSMutableArray array];
  AppendNode(systemWide, element, 0, nodes);
  CFRelease(systemWide);
  CFRelease(element);
  return nodes;
}

static BOOL ContainsQianwenWebArea(NSArray<NSDictionary *> *nodes) {
  for (NSDictionary *node in nodes) {
    NSString *role = node[@"role"];
    NSString *url = node[@"url"];
    if ([role isEqualToString:@"AXWebArea"]
        && [url containsString:@"qianwen.com/"]) {
      return YES;
    }
  }
  return NO;
}

static NSRunningApplication *BestApplication(NSMutableArray<NSDictionary *> **selectedNodes) {
  NSArray<NSRunningApplication *> *applications =
    [NSRunningApplication runningApplicationsWithBundleIdentifier:QianwenBundleIdentifier];
  if (applications.count == 0) {
    NSURL *applicationURL = [NSURL fileURLWithPath:QianwenApplicationPath];
    [[NSWorkspace sharedWorkspace]
      openApplicationAtURL:applicationURL
      configuration:[NSWorkspaceOpenConfiguration configuration]
      completionHandler:^(__unused NSRunningApplication *application, __unused NSError *error) {}];
  }

  NSRunningApplication *bestApplication = nil;
  NSMutableArray<NSDictionary *> *bestNodes = [NSMutableArray array];
  NSUInteger bestScore = 0;
  for (NSUInteger attempt = 0; attempt < 12; attempt += 1) {
    applications = [NSRunningApplication runningApplicationsWithBundleIdentifier:QianwenBundleIdentifier];
    for (NSRunningApplication *application in applications) {
      if (application.terminated) continue;
      NSMutableArray<NSDictionary *> *nodes = NodesForApplication(application);
      NSUInteger score = nodes.count + (ContainsQianwenWebArea(nodes) ? MaximumNodeCount : 0);
      if (score > bestScore) {
        bestApplication = application;
        bestNodes = nodes;
        bestScore = score;
      }
    }
    if (bestApplication != nil && ContainsQianwenWebArea(bestNodes)) break;
    NSRunningApplication *candidate = bestApplication ?: applications.firstObject;
    [candidate activateWithOptions:0];
    usleep(250000);
  }
  if (selectedNodes != NULL) *selectedNodes = bestNodes;
  return bestApplication;
}

static NSDictionary *ApplicationContext(void) {
  if (!AXIsProcessTrusted()) {
    return @{ @"status": @"accessibility_denied", @"nodes": @[] };
  }
  NSMutableArray<NSDictionary *> *nodes = nil;
  NSRunningApplication *application = BestApplication(&nodes);
  if (application == nil || application.terminated) {
    return @{ @"status": @"app_not_running", @"nodes": @[] };
  }
  if (nodes.count <= 1) return @{ @"status": @"incompatible", @"nodes": @[] };

  NSMutableArray<NSString *> *textValues = [NSMutableArray array];
  for (NSDictionary *node in nodes) {
    for (NSString *key in @[@"title", @"value", @"description"]) {
      NSString *text = node[key];
      if ([text isKindOfClass:NSString.class] && text.length > 0) [textValues addObject:text];
    }
  }
  NSString *allText = [textValues componentsJoinedByString:@"\n"];
  NSString *status = @"ok";
  if ([allText containsString:@"登录千问"] || [allText containsString:@"请先登录"]) {
    status = @"login_required";
  } else if ([allText containsString:@"网络异常"] || [allText containsString:@"加载失败"]) {
    status = @"network_failed";
  }
  return @{ @"status": status, @"nodes": nodes };
}

static CGRect SummaryCropRect(NSArray<NSDictionary *> *nodes) {
  CGRect splitterFrame = CGRectZero;
  for (NSDictionary *node in nodes) {
    if (![node[@"role"] isEqualToString:@"AXSplitter"]) continue;
    NSDictionary *frame = node[@"frame"];
    if (![frame isKindOfClass:NSDictionary.class]) continue;
    CGRect candidate = CGRectMake(
      [frame[@"x"] doubleValue],
      [frame[@"y"] doubleValue],
      [frame[@"width"] doubleValue],
      [frame[@"height"] doubleValue]
    );
    if (candidate.size.height > splitterFrame.size.height) splitterFrame = candidate;
  }
  if (splitterFrame.size.height < 200) return CGRectZero;

  CGFloat paneStart = CGRectGetMaxX(splitterFrame);
  CGRect best = CGRectZero;
  for (NSDictionary *node in nodes) {
    if (![node[@"role"] isEqualToString:@"AXGroup"]) continue;
    NSDictionary *frame = node[@"frame"];
    if (![frame isKindOfClass:NSDictionary.class]) continue;
    CGRect candidate = CGRectMake(
      [frame[@"x"] doubleValue],
      [frame[@"y"] doubleValue],
      [frame[@"width"] doubleValue],
      [frame[@"height"] doubleValue]
    );
    if (
      fabs(candidate.origin.x - paneStart) > 8
      || candidate.origin.y < splitterFrame.origin.y + 120
      || candidate.size.width < 500
      || candidate.size.height < 250
    ) {
      continue;
    }
    if (CGRectEqualToRect(best, CGRectZero) || candidate.origin.y < best.origin.y) best = candidate;
  }
  return best;
}

static SCWindow *BestShareableWindow(pid_t processIdentifier) {
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  __block SCShareableContent *content = nil;
  __block NSError *contentError = nil;
  [SCShareableContent
    getShareableContentExcludingDesktopWindows:YES
    onScreenWindowsOnly:YES
    completionHandler:^(SCShareableContent *result, NSError *error) {
      content = result;
      contentError = error;
      dispatch_semaphore_signal(semaphore);
    }];
  if (dispatch_semaphore_wait(
    semaphore,
    dispatch_time(DISPATCH_TIME_NOW, (int64_t)(8 * NSEC_PER_SEC))
  ) != 0 || contentError != nil) {
    return nil;
  }

  SCWindow *bestWindow = nil;
  CGFloat bestArea = 0;
  for (SCWindow *window in content.windows) {
    if (window.owningApplication.processID != processIdentifier) continue;
    if (window.windowLayer != 0 || !window.onScreen) continue;
    CGFloat area = window.frame.size.width * window.frame.size.height;
    if (area <= bestArea) continue;
    bestWindow = window;
    bestArea = area;
  }
  return bestWindow;
}

static CGImageRef CopyWindowImage(SCWindow *window) {
  SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
  CGFloat scale = MAX(filter.pointPixelScale, 1);
  SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
  configuration.width = (size_t)ceil(window.frame.size.width * scale);
  configuration.height = (size_t)ceil(window.frame.size.height * scale);
  configuration.showsCursor = NO;
  configuration.ignoreShadowsSingleWindow = YES;
  configuration.scalesToFit = NO;

  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  __block CGImageRef image = NULL;
  __block NSError *captureError = nil;
  [SCScreenshotManager
    captureImageWithFilter:filter
    configuration:configuration
    completionHandler:^(CGImageRef result, NSError *error) {
      if (result != NULL) image = CGImageRetain(result);
      captureError = error;
      dispatch_semaphore_signal(semaphore);
    }];
  if (dispatch_semaphore_wait(
    semaphore,
    dispatch_time(DISPATCH_TIME_NOW, (int64_t)(8 * NSEC_PER_SEC))
  ) != 0 || captureError != nil) {
    if (image != NULL) CGImageRelease(image);
    return NULL;
  }
  return image;
}

static NSArray<NSDictionary *> *RecognizedSummaryNodes(CGImageRef image, CGRect globalCrop) {
  VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
  request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
  request.recognitionLanguages = @[@"zh-Hans", @"en-US"];
  request.usesLanguageCorrection = YES;
  request.minimumTextHeight = 0.008;
  VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
  NSError *error = nil;
  if (![handler performRequests:@[request] error:&error] || error != nil) return @[];

  NSArray<VNRecognizedTextObservation *> *observations = [request.results sortedArrayUsingComparator:(
    ^NSComparisonResult(VNRecognizedTextObservation *left, VNRecognizedTextObservation *right) {
      CGFloat leftTop = CGRectGetMaxY(left.boundingBox);
      CGFloat rightTop = CGRectGetMaxY(right.boundingBox);
      if (fabs(leftTop - rightTop) > 0.015) {
        return leftTop > rightTop ? NSOrderedAscending : NSOrderedDescending;
      }
      return left.boundingBox.origin.x < right.boundingBox.origin.x
        ? NSOrderedAscending
        : NSOrderedDescending;
    }
  )];
  NSMutableArray<NSDictionary *> *nodes = [NSMutableArray array];
  for (VNRecognizedTextObservation *observation in observations) {
    VNRecognizedText *candidate = [observation topCandidates:1].firstObject;
    NSString *value = [candidate.string stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (candidate == nil || candidate.confidence < 0.45 || value.length == 0) continue;
    CGRect box = observation.boundingBox;
    CGRect frame = CGRectMake(
      globalCrop.origin.x + box.origin.x * globalCrop.size.width,
      globalCrop.origin.y + (1 - CGRectGetMaxY(box)) * globalCrop.size.height,
      box.size.width * globalCrop.size.width,
      box.size.height * globalCrop.size.height
    );
    [nodes addObject:@{
      @"depth": @0,
      @"role": @"OCRStaticText",
      @"value": value,
      @"actions": @[],
      @"hittable": @YES,
      @"frame": @{
        @"x": @(frame.origin.x),
        @"y": @(frame.origin.y),
        @"width": @(frame.size.width),
        @"height": @(frame.size.height),
      },
    }];
  }
  return nodes;
}

static NSDictionary *SummaryContext(void) {
  if (!AXIsProcessTrusted()) return @{ @"status": @"accessibility_denied", @"nodes": @[] };
  NSMutableArray<NSDictionary *> *nodes = nil;
  NSRunningApplication *application = BestApplication(&nodes);
  if (application == nil || application.terminated) {
    return @{ @"status": @"app_not_running", @"nodes": @[] };
  }
  CGRect globalCrop = SummaryCropRect(nodes);
  if (CGRectEqualToRect(globalCrop, CGRectZero)) {
    return @{ @"status": @"incompatible", @"nodes": @[] };
  }
  SCWindow *window = BestShareableWindow(application.processIdentifier);
  if (window == nil || CGRectEqualToRect(window.frame, CGRectZero)) {
    return @{ @"status": @"incompatible", @"nodes": @[] };
  }
  CGRect windowBounds = window.frame;
  CGImageRef windowImage = CopyWindowImage(window);
  if (windowImage == NULL) return @{ @"status": @"incompatible", @"nodes": @[] };
  CGFloat scaleX = (CGFloat)CGImageGetWidth(windowImage) / windowBounds.size.width;
  CGFloat scaleY = (CGFloat)CGImageGetHeight(windowImage) / windowBounds.size.height;
  CGRect pixelCrop = CGRectMake(
    (globalCrop.origin.x - windowBounds.origin.x) * scaleX,
    (globalCrop.origin.y - windowBounds.origin.y) * scaleY,
    globalCrop.size.width * scaleX,
    globalCrop.size.height * scaleY
  );
  CGRect imageBounds = CGRectMake(
    0,
    0,
    CGImageGetWidth(windowImage),
    CGImageGetHeight(windowImage)
  );
  pixelCrop = CGRectIntersection(pixelCrop, imageBounds);
  CGImageRef crop = CGRectIsEmpty(pixelCrop)
    ? NULL
    : CGImageCreateWithImageInRect(windowImage, pixelCrop);
  CGImageRelease(windowImage);
  if (crop == NULL) return @{ @"status": @"incompatible", @"nodes": @[] };
  NSArray<NSDictionary *> *recognized = RecognizedSummaryNodes(crop, globalCrop);
  CGImageRelease(crop);
  return @{ @"status": @"ok", @"nodes": recognized };
}

static BOOL TextMatches(AXUIElementRef element, NSString *target) {
  NSArray<NSString *> *values = @[
    StringAttribute(element, kAXTitleAttribute) ?: @"",
    StringAttribute(element, kAXValueAttribute) ?: @"",
    StringAttribute(element, kAXDescriptionAttribute) ?: @"",
  ];
  for (NSString *value in values) {
    if ([value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]
        .length == 0) continue;
    if ([value isEqualToString:target]) return YES;
  }
  return NO;
}

static BOOL ElementFrame(AXUIElementRef element, CGRect *frame) {
  CFTypeRef positionValue = NULL;
  CFTypeRef sizeValue = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &positionValue) != kAXErrorSuccess
      || positionValue == NULL
      || CFGetTypeID(positionValue) != AXValueGetTypeID()
      || AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &sizeValue) != kAXErrorSuccess
      || sizeValue == NULL
      || CFGetTypeID(sizeValue) != AXValueGetTypeID()) {
    if (positionValue != NULL) CFRelease(positionValue);
    if (sizeValue != NULL) CFRelease(sizeValue);
    return NO;
  }
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  BOOL valid = AXValueGetValue((AXValueRef)positionValue, kAXValueCGPointType, &position)
    && AXValueGetValue((AXValueRef)sizeValue, kAXValueCGSizeType, &size);
  CFRelease(positionValue);
  CFRelease(sizeValue);
  if (!valid || size.width < 2 || size.height < 2) return NO;
  *frame = (CGRect){ .origin = position, .size = size };
  return YES;
}

static AXUIElementRef CopyMatchingElement(AXUIElementRef element, NSString *target, NSUInteger depth) {
  if (depth > MaximumDepth) return NULL;
  if (TextMatches(element, target)) {
    AXUIElementRef pressable = CopyNearestPressable(element);
    if (pressable != NULL) return pressable;
    CGRect frame = CGRectZero;
    if (ElementFrame(element, &frame)) return (AXUIElementRef)CFRetain(element);
  }
  for (id child in Children(element)) {
    if (CFGetTypeID((__bridge CFTypeRef)child) != AXUIElementGetTypeID()) continue;
    AXUIElementRef matched = CopyMatchingElement(
      (__bridge AXUIElementRef)child,
      target,
      depth + 1
    );
    if (matched != NULL) return matched;
  }
  return NULL;
}

static AXError ActivateElement(AXUIElementRef element) {
  AXUIElementPerformAction(element, CFSTR("AXScrollToVisible"));
  AXUIElementSetAttributeValue(element, kAXFocusedAttribute, kCFBooleanTrue);
  CGRect frame = CGRectZero;
  if (ElementFrame(element, &frame)) {
    CGPoint point = CGPointMake(CGRectGetMidX(frame), CGRectGetMidY(frame));
    CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, point, kCGMouseButtonLeft);
    CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
    CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
    if (move != NULL && down != NULL && up != NULL) {
      CGEventPost(kCGHIDEventTap, move);
      CGEventPost(kCGHIDEventTap, down);
      usleep(50000);
      CGEventPost(kCGHIDEventTap, up);
      CFRelease(move);
      CFRelease(down);
      CFRelease(up);
      usleep(500000);
      return kAXErrorSuccess;
    }
    if (move != NULL) CFRelease(move);
    if (down != NULL) CFRelease(down);
    if (up != NULL) CFRelease(up);
  }
  if ([Actions(element) containsObject:(__bridge NSString *)kAXPressAction]) {
    return AXUIElementPerformAction(element, kAXPressAction);
  }
  return kAXErrorCannotComplete;
}

static NSDictionary *Press(NSString *target) {
  NSDictionary *context = ApplicationContext();
  if (![context[@"status"] isEqualToString:@"ok"]) return context;
  NSRunningApplication *application = BestApplication(NULL);
  if (application == nil) return @{ @"status": @"app_not_running", @"nodes": @[] };
  [application activateWithOptions:NSApplicationActivateAllWindows];
  usleep(300000);
  AXUIElementRef element = AXUIElementCreateApplication(application.processIdentifier);
  AXUIElementRef matched = CopyMatchingElement(element, target, 0);
  CFRelease(element);
  if (matched == NULL) return @{ @"status": @"incompatible", @"nodes": @[] };
  AXError result = ActivateElement(matched);
  CFRelease(matched);
  return @{
    @"status": result == kAXErrorSuccess ? @"ok" : @"incompatible",
    @"nodes": @[],
  };
}

static void WriteJSON(NSDictionary *value) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
  if (data == nil || error != nil) {
    data = [@"{\"status\":\"incompatible\",\"nodes\":[]}" dataUsingEncoding:NSUTF8StringEncoding];
  }
  fwrite(data.bytes, 1, data.length, stdout);
  fwrite("\n", 1, 1, stdout);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "snapshot") == 0) {
      WriteJSON(ApplicationContext());
      return 0;
    }
    if (argc == 2 && strcmp(argv[1], "summary") == 0) {
      WriteJSON(SummaryContext());
      return 0;
    }
    if (argc == 3 && strcmp(argv[1], "press") == 0) {
      NSString *target = [NSString stringWithUTF8String:argv[2]];
      WriteJSON(target.length == 0
        ? @{ @"status": @"incompatible", @"nodes": @[] }
        : Press(target));
      return 0;
    }
    WriteJSON(@{ @"status": @"incompatible", @"nodes": @[] });
    return 2;
  }
}
